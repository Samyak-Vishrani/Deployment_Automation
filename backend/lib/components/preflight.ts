/**
 * Pre-flight: independent checks that must all pass before a project's
 * components can be deployed.
 *
 * Pure apart from the injected dependencies, so it is tested with a fake tree
 * and a fake credential lookup. Never reports an env var VALUE, only names.
 */

import type { ComponentKind, ProviderId } from "@prisma/client";
import { reservedReason } from "@/lib/env/env-rules";
import { systemEnvKeys } from "@/lib/env/system-env";
import { CAN_DEPLOY, NEON_ENGINES, PROVIDER_LABEL, PROVIDER_PHASE, RENDER_FRAMEWORKS } from "./provider-rules";

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
  /** Read by the provider-specific checks (Render needs both). */
  framework?: string | null;
  startCmd?: string | null;
  /** Read for the frontend's API URL key (react-scripts vs Vite). */
  buildCmd?: string | null;
};

/** A component's stored env var names (its own + shared for a backend), and those with a value. */
export type ComponentEnvKeys = { keys: string[]; filled: Set<string> };

export type PreflightProject = {
  userId: string;
  /** Phase 9: per component, from EnvVar. System keys (DATABASE_URL, the API URL) are added here. */
  envFor(component: PreflightComponent): ComponentEnvKeys;
};

export type RepoTreeEntry = { path: string; type: "blob" | "tree" | string };

export type PreflightDeps = {
  /** The repository tree at the commit being checked. */
  listTree(): Promise<{ entries: RepoTreeEntry[]; truncated: boolean }>;
  readFile(path: string): Promise<string>;
  credentialState(userId: string, provider: ProviderId): Promise<CredentialState>;
};

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

  for (const component of components) {
    if (component.kind === "database") {
      if (component.provider === "neon") checks.push(...databaseChecks(component));
      continue;
    }
    const env = project.envFor(component);
    // What OrbitOps sets at deploy time (a Neon database's DATABASE_URL, the
    // backend's URL on a frontend) is not a missing value.
    const system = systemEnvKeys({ ...component, framework: component.framework ?? null, buildCmd: component.buildCmd ?? null }, components);
    const filled = new Set([...env.filled, ...system.map((k) => k.key)]);
    checks.push(rootDirCheck(component, tree, folders, treeError));
    checks.push(await envCheck(component, files, filled, deps, treeError));
    const reserved = reservedCheck(component, env.keys);
    if (reserved) checks.push(reserved);
    if (component.provider === "render") checks.push(...renderChecks(component));
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
    // A database "deploys" by being provisioned (Neon, Phase 8).
    deployable[component.id] =
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
      message:
        `${component.name}: ${examplePath} needs ${missing.join(", ")}, which ${missing.length === 1 ? "has" : "have"} no value. ` +
        `Add ${missing.length === 1 ? "it" : "them"} under ${component.name} → Environment` +
        (component.kind === "backend" ? " (or Shared)." : "."),
    };
  }
  return { ...base, status: "pass", message: `${component.name}: every variable in ${examplePath} has a value.` };
}

/**
 * A stored key the provider sets itself (RENDER_*, VERCEL_*…). Saving refuses
 * these, but a shared key saved before a Render backend existed can still
 * reach one. Only reported when there is a problem.
 */
function reservedCheck(component: PreflightComponent, keys: string[]): PreflightCheck | null {
  const reasons = keys.map((key) => reservedReason(key, component.provider)).filter((r): r is string => Boolean(r));
  if (reasons.length === 0) return null;
  return {
    id: `env-reserved:${component.id}`,
    componentId: component.id,
    status: "fail",
    message: `${component.name}: ${reasons.join("; ")}. Remove ${reasons.length === 1 ? "it" : "them"} from its Environment (or Shared).`,
  };
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
      return {
        ...base,
        status: "pass",
        message:
          provider === "render"
            ? "Render account connected. Render builds from GitHub itself, so it must also be connected to GitHub " +
              "with access to this repository (dashboard.render.com → Account Settings → Git)."
            : `${label} account connected.`,
      };
    case "invalid":
      return {
        ...base,
        status: "fail",
        message: `${label} rejected the saved ${provider === "vercel" ? "token" : "API key"}. Reconnect ${label} in Settings.`,
      };
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

/**
 * What Render needs that other providers do not: a runtime it can tell from
 * the framework, and (for a native runtime) a start command.
 */
function renderChecks(component: PreflightComponent): PreflightCheck[] {
  const framework = component.framework?.trim().toLowerCase() ?? "";
  const runtimeKnown = RENDER_FRAMEWORKS.has(framework);
  const checks: PreflightCheck[] = [
    {
      id: `runtime:${component.id}`,
      componentId: component.id,
      status: runtimeKnown ? "pass" : "fail",
      message: runtimeKnown
        ? `${component.name}: Render can run ${framework}.`
        : `${component.name}: set a framework Render can run (e.g. express, nestjs, fastapi, docker); ` +
          `"${component.framework ?? "none"}" is not one.`,
    },
  ];
  if (framework !== "docker") {
    const hasStart = Boolean(component.startCmd?.trim());
    checks.push({
      id: `start-cmd:${component.id}`,
      componentId: component.id,
      status: hasStart ? "pass" : "fail",
      message: hasStart
        ? `${component.name}: starts with "${component.startCmd!.trim()}".`
        : `${component.name}: add a start command; Render needs one to run the service (e.g. "npm start").`,
    });
  }
  return checks;
}

/**
 * What a Neon database needs: a Postgres engine. Migrations are the user's
 * job, so the second check always passes and carries the advice.
 */
function databaseChecks(component: PreflightComponent): PreflightCheck[] {
  const engine = component.framework?.trim().toLowerCase() ?? "";
  const postgres = NEON_ENGINES.has(engine);
  return [
    {
      id: `engine:${component.id}`,
      componentId: component.id,
      status: postgres ? "pass" : "fail",
      message: postgres
        ? `${component.name}: Postgres on Neon.`
        : `${component.name}: Neon hosts Postgres only; this database is "${component.framework}". ` +
          "Set the engine to postgres, or remove the database card.",
    },
    {
      id: `migrations:${component.id}`,
      componentId: component.id,
      status: "pass",
      message:
        `${component.name}: the backend gets DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED (direct). ` +
        "Migrations are not run for you: add one to the backend's build command, e.g. " +
        '"npm install && npx prisma migrate deploy" (with Prisma, set directUrl = env("DATABASE_URL_UNPOOLED")).',
    },
  ];
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
