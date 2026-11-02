import type { ComponentKind, ProviderId } from "@prisma/client";
import { badRequest } from "@/lib/api/http-error";
import { asObject, rejectUnknownKeys } from "@/lib/projects/project-input";
import {
  COMPONENT_KINDS,
  isAllowedProvider,
  KIND_LABEL,
  PROVIDER_FOR_KIND,
  PROVIDER_IDS,
  PROVIDER_LABEL,
} from "./provider-rules";

/**
 * Request-body validation for the component endpoints, written out by hand in
 * the style of project-input.ts: unknown keys are rejected, every string has a
 * maximum length.
 */

export interface ComponentInput {
  kind: ComponentKind;
  name: string;
  /** Normalised: no leading "./", no trailing "/", "." for the root. */
  rootDir: string;
  framework: string | null;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  outputDir: string | null;
  nodeVersion: string | null;
  /** Path the provider checks once the service is up, e.g. "/health". Backends only. */
  healthCheckPath: string | null;
  provider: ProviderId;
  analysisComponentId: string | null;
}

/** `kind` is not editable: changing what a component is means removing it and adding another. */
export type UpdateComponentInput = Partial<Omit<ComponentInput, "kind" | "analysisComponentId">>;

const COMPONENT_KEYS = [
  "kind",
  "name",
  "rootDir",
  "framework",
  "installCmd",
  "buildCmd",
  "startCmd",
  "outputDir",
  "nodeVersion",
  "healthCheckPath",
  "provider",
  "analysisComponentId",
] as const;

const UPDATE_KEYS = COMPONENT_KEYS.filter((key) => key !== "kind" && key !== "analysisComponentId");

const COMMAND_KEYS = ["installCmd", "buildCmd", "startCmd"] as const;

const MAX_COMPONENTS = 20;
const MAX_COMMAND = 500;

/** Control characters, newlines included. A command is one line of shell. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function nullableString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw badRequest(`${key} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw badRequest(`${key} must be at most ${maxLength} characters.`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw badRequest(`${key} must be a single line.`);
  }
  return trimmed === "" ? null : trimmed;
}

/**
 * A folder inside the repository. Rejected rather than cleaned up when it
 * could point outside it: "..", an absolute path, a drive letter or a
 * backslash all mean the user meant something we would get wrong.
 */
function relativePath(value: string, key: string): string {
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    throw badRequest(`${key} must be a path relative to the repository root, like "frontend" or ".".`);
  }
  const segments = value.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw badRequest(`${key} must not contain "..": it has to stay inside the repository.`);
  }
  return segments.length === 0 ? "." : segments.join("/");
}

function optionalPath(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = nullableString(body, key, 500);
  return value === undefined || value === null ? value : relativePath(value, key);
}

/** A URL path on the deployed service: starts with "/", no spaces, no query string. */
function optionalHealthPath(body: Record<string, unknown>): string | null | undefined {
  const value = nullableString(body, "healthCheckPath", 200);
  if (value === undefined || value === null) return value;
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(value)) {
    throw badRequest('healthCheckPath must be a path starting with "/", like "/health".');
  }
  return value;
}

function parseKind(value: unknown, at: string): ComponentKind {
  if (typeof value !== "string" || !COMPONENT_KINDS.includes(value as ComponentKind)) {
    throw badRequest(`${at}kind must be one of ${COMPONENT_KINDS.join(", ")}.`);
  }
  return value as ComponentKind;
}

function parseProvider(value: unknown, at: string): ProviderId {
  if (typeof value !== "string" || !PROVIDER_IDS.includes(value as ProviderId)) {
    throw badRequest(`${at}provider must be one of ${PROVIDER_IDS.join(", ")}.`);
  }
  return value as ProviderId;
}

/** Throws unless `provider` is the one the MVP allows for `kind`. */
export function assertProviderAllowed(kind: ComponentKind, provider: ProviderId, at = ""): void {
  if (!isAllowedProvider(kind, provider)) {
    throw badRequest(
      `${at}A ${KIND_LABEL[kind].toLowerCase()} component deploys to ${PROVIDER_LABEL[PROVIDER_FOR_KIND[kind]]}, ` +
        `not ${PROVIDER_LABEL[provider]}.`,
    );
  }
}

/** A database is provisioned, not built: commands on one are a mistake, not something to ignore. */
function assertNoCommands(kind: ComponentKind, fields: Partial<Record<string, string | null>>, at: string) {
  if (kind !== "database") return;
  const set = [...COMMAND_KEYS, "outputDir" as const, "healthCheckPath" as const].filter((key) => fields[key]);
  if (set.length > 0) {
    throw badRequest(`${at}A database component has no ${set.join(", ")}.`);
  }
}

function parseComponent(body: unknown, index: number): ComponentInput {
  const at = `components[${index}]: `;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest(`${at}must be an object.`);
  }
  const raw = body as Record<string, unknown>;
  try {
    rejectUnknownKeys(raw, COMPONENT_KEYS);
  } catch (error) {
    throw badRequest(`${at}${(error as Error).message}`);
  }

  const kind = parseKind(raw.kind, at);
  const provider = raw.provider === undefined ? PROVIDER_FOR_KIND[kind] : parseProvider(raw.provider, at);
  assertProviderAllowed(kind, provider, at);

  const name = nullableString(raw, "name", 100);
  if (!name) {
    throw badRequest(`${at}name is required.`);
  }

  const fields = {
    framework: nullableString(raw, "framework", 100) ?? null,
    installCmd: nullableString(raw, "installCmd", MAX_COMMAND) ?? null,
    buildCmd: nullableString(raw, "buildCmd", MAX_COMMAND) ?? null,
    startCmd: nullableString(raw, "startCmd", MAX_COMMAND) ?? null,
    outputDir: optionalPath(raw, "outputDir") ?? null,
    nodeVersion: nullableString(raw, "nodeVersion", 100) ?? null,
    healthCheckPath: optionalHealthPath(raw) ?? null,
  };
  assertNoCommands(kind, fields, at);

  return {
    kind,
    name,
    rootDir: optionalPath(raw, "rootDir") ?? ".",
    ...fields,
    provider,
    analysisComponentId: nullableString(raw, "analysisComponentId", 100) ?? null,
  };
}

/** Body of `PUT /components`: `{ components: [...] }`, the complete set to keep. */
export function parseComponentSet(body: unknown): ComponentInput[] {
  const raw = asObject(body);
  rejectUnknownKeys(raw, ["components"]);

  if (!Array.isArray(raw.components)) {
    throw badRequest("components must be an array.");
  }
  if (raw.components.length > MAX_COMPONENTS) {
    throw badRequest(`A project can have at most ${MAX_COMPONENTS} components.`);
  }

  const components = raw.components.map(parseComponent);

  if (components.filter((c) => c.kind === "database").length > 1) {
    throw badRequest("A project can have at most one database component.");
  }

  const seen = new Set<string>();
  for (const component of components) {
    const key = `${component.kind}:${component.rootDir}`;
    if (seen.has(key)) {
      throw badRequest(
        `Two ${component.kind} components use the folder "${component.rootDir}". Remove one of them.`,
      );
    }
    seen.add(key);
  }

  return components;
}

/** Body of `PATCH /components/:id`. The provider rule needs the stored kind, so the service checks it. */
export function parseUpdateComponent(body: unknown): UpdateComponentInput {
  const raw = asObject(body);
  rejectUnknownKeys(raw, UPDATE_KEYS);

  const name = nullableString(raw, "name", 100);
  if (name === null) {
    throw badRequest("name cannot be empty.");
  }
  const rootDir = optionalPath(raw, "rootDir");

  return {
    ...(name !== undefined && { name }),
    ...(rootDir !== undefined && { rootDir: rootDir ?? "." }),
    ...optional("framework", nullableString(raw, "framework", 100)),
    ...optional("installCmd", nullableString(raw, "installCmd", MAX_COMMAND)),
    ...optional("buildCmd", nullableString(raw, "buildCmd", MAX_COMMAND)),
    ...optional("startCmd", nullableString(raw, "startCmd", MAX_COMMAND)),
    ...optional("outputDir", optionalPath(raw, "outputDir")),
    ...optional("nodeVersion", nullableString(raw, "nodeVersion", 100)),
    ...optional("healthCheckPath", optionalHealthPath(raw)),
    ...(raw.provider !== undefined && { provider: parseProvider(raw.provider, "") }),
  };
}

/** Checks a merged update against the component's kind. */
export function assertValidUpdate(kind: ComponentKind, merged: UpdateComponentInput): void {
  if (merged.provider) assertProviderAllowed(kind, merged.provider);
  assertNoCommands(kind, merged, "");
}

function optional<K extends string>(key: K, value: string | null | undefined) {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string | null>);
}
