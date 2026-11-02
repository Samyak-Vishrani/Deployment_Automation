/**
 * Pre-flight: independent checks that must all pass before a project's
 * components can be deployed.
 *
 * Pure apart from the injected dependencies, so it is tested with a fake tree
 * and a fake credential lookup. Never reports an env var VALUE, only names.
 */

import type { ComponentKind, ProviderId } from "@prisma/client";
import { CAN_DEPLOY, PROVIDER_LABEL, PROVIDER_PHASE } from "./provider-rules";

export type CheckStatus = "pass" | "fail" | "pending";

export type PreflightCheck = {
  id: string;
  componentId?: string;
  status: CheckStatus;
  message: string;
};

export type PreflightResult = {
  /** Every check passed: the whole project can be deployed (Phase 8's "Deploy all"). */
  ok: boolean;
  checks: PreflightCheck[];
  /**
   * Per component id: its own checks and its provider's account check pass, and
   * its provider can already deploy. Drives the per-component Deploy buttons.
   */
  deployable: Record<string, boolean>;
};

/**
 * A provider account's state. "unavailable" means the integration service that
 * holds the account could not be asked.
 */
export type CredentialState = "connected" | "invalid" | "missing" | "unavailable";

export type PreflightComponent = {
  id: string;
  kind: ComponentKind;
  name: string;
  rootDir: string;
  provider: ProviderId;
};

export type PreflightProject = {
  userId: string;
  /** Env var names that have a non-empty value. */
  filledEnvKeys: string[];
};

export type RepoTreeEntry = { path: string; type: "blob" | "tree" | string };

export type PreflightDeps = {
  /** The repository tree at the commit being checked. */
  listTree(): Promise<{ entries: RepoTreeEntry[]; truncated: boolean }>;
  readFile(path: string): Promise<string>;
  credentialState(userId: string, provider: ProviderId): Promise<CredentialState>;
};

/**
 * Env vars a configured database component will supply once it is provisioned,
 * so a backend's .env.example asking for them is not a missing value.
 */
const PROVIDED_BY_DATABASE = ["DATABASE_URL"];

export async function runPreflight(
  project: PreflightProject,
  components: PreflightComponent[],
  deps: PreflightDeps,
): Promise<PreflightResult> {
  if (components.length === 0) {
    return {
      ok: false,
      deployable: {},
      checks: [
        {
          id: "components",
          status: "fail",
          message: "No components are configured. Add at least one and save.",
        },
      ],
    };
  }

  const checks: PreflightCheck[] = [
    {
      id: "components",
      status: "pass",
      message: `${components.length} component${components.length === 1 ? "" : "s"} configured.`,
    },
  ];

  let tree: { entries: RepoTreeEntry[]; truncated: boolean } | null = null;
  let treeError = "";
  try {
    tree = await deps.listTree();
  } catch (error) {
    treeError = (error as Error).message || "Could not read the repository.";
  }

  const folders = new Set(tree?.entries.filter((e) => e.type === "tree").map((e) => e.path));
  const files = new Set(tree?.entries.filter((e) => e.type === "blob").map((e) => e.path));
  const hasDatabase = components.some((c) => c.kind === "database");
  const filled = new Set([...project.filledEnvKeys, ...(hasDatabase ? PROVIDED_BY_DATABASE : [])]);

  for (const component of components) {
    if (component.kind === "database") continue;
    checks.push(rootDirCheck(component, tree, folders, treeError));
    checks.push(await envCheck(component, files, filled, deps, treeError));
  }

  const providers = [...new Set(components.map((c) => c.provider))];
  for (const provider of providers) {
    checks.push(await credentialCheck(project.userId, provider, deps));
  }

  const credentialPasses = new Set(
    checks.filter((c) => c.id.startsWith("credential:") && c.status === "pass").map((c) => c.id.slice("credential:".length)),
  );
  const deployable: Record<string, boolean> = {};
  for (const component of components) {
    deployable[component.id] =
      component.kind !== "database" &&
      CAN_DEPLOY.has(component.provider) &&
      credentialPasses.has(component.provider) &&
      checks.filter((c) => c.componentId === component.id).every((c) => c.status === "pass");
  }

  return { ok: checks.every((check) => check.status === "pass"), checks, deployable };
}

function rootDirCheck(
  component: PreflightComponent,
  tree: { truncated: boolean } | null,
  folders: Set<string>,
  treeError: string,
): PreflightCheck {
  const base = { id: `root-dir:${component.id}`, componentId: component.id };
  if (component.rootDir === ".") {
    return { ...base, status: "pass", message: `${component.name}: builds from the repository root.` };
  }
  if (!tree) {
    return { ...base, status: "fail", message: `${component.name}: ${treeError}` };
  }
  if (folders.has(component.rootDir)) {
    return { ...base, status: "pass", message: `${component.name}: folder "${component.rootDir}" exists.` };
  }
  if (tree.truncated) {
    // GitHub stops listing a very large tree part-way; absence proves nothing.
    return {
      ...base,
      status: "pending",
      message: `${component.name}: the repository is too large to confirm that "${component.rootDir}" exists.`,
    };
  }
  return {
    ...base,
    status: "fail",
    message: `${component.name}: folder "${component.rootDir}" does not exist on the branch.`,
  };
}

async function envCheck(
  component: PreflightComponent,
  files: Set<string>,
  filled: Set<string>,
  deps: PreflightDeps,
  treeError: string,
): Promise<PreflightCheck> {
  const base = { id: `env:${component.id}`, componentId: component.id };
  if (treeError) {
    return { ...base, status: "pending", message: `${component.name}: env vars not checked, the repository could not be read.` };
  }

  const examplePath = component.rootDir === "." ? ".env.example" : `${component.rootDir}/.env.example`;
  if (!files.has(examplePath)) {
    return { ...base, status: "pass", message: `${component.name}: no ${examplePath}, so no env vars are required.` };
  }

  let content: string;
  try {
    content = await deps.readFile(examplePath);
  } catch {
    return { ...base, status: "pending", message: `${component.name}: could not read ${examplePath}.` };
  }

  const missing = envExampleKeys(content).filter((key) => !filled.has(key));
  if (missing.length > 0) {
    return {
      ...base,
      status: "fail",
      message: `${component.name}: ${examplePath} needs ${missing.join(", ")}, which ${missing.length === 1 ? "has" : "have"} no value.`,
    };
  }
  return { ...base, status: "pass", message: `${component.name}: every variable in ${examplePath} has a value.` };
}

async function credentialCheck(
  userId: string,
  provider: ProviderId,
  deps: PreflightDeps,
): Promise<PreflightCheck> {
  const base = { id: `credential:${provider}` };
  const label = PROVIDER_LABEL[provider];
  if (provider === "local_docker") {
    return { ...base, status: "pass", message: `${label} needs no account.` };
  }
  if (!CAN_DEPLOY.has(provider)) {
    return {
      ...base,
      status: "pending",
      message: `Deploying to ${label} arrives in Phase ${PROVIDER_PHASE[provider]}.`,
    };
  }

  switch (await deps.credentialState(userId, provider)) {
    case "connected":
      return { ...base, status: "pass", message: `${label} account connected.` };
    case "invalid":
      return { ...base, status: "fail", message: `${label} rejected the saved token. Reconnect ${label} in Settings.` };
    case "unavailable":
      return {
        ...base,
        status: "fail",
        message: `The ${label} integration service is not running, so the ${label} account could not be checked.`,
      };
    default:
      return { ...base, status: "fail", message: `Connect ${label} in Settings to deploy there.` };
  }
}

/** Variable names declared in a .env.example: `KEY=...` or `export KEY=...`, comments skipped. */
export function envExampleKeys(content: string): string[] {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return [...keys];
}
