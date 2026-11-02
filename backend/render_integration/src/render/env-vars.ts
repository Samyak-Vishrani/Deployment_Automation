import { createHash } from "node:crypto";
import type { ComponentSpec, EnvVar } from "../types";
import type { RenderRuntime } from "./runtime-map";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The env vars a service is given: the project's own, plus the runtime
 * version Render reads from the environment when the user has not set it.
 *
 * - NODE_VERSION accepts a major ("20").
 * - PYTHON_VERSION must be fully specified ("3.12.4"), so it is only derived
 *   from a version that already is.
 */
export function toEnvVars(projectEnv: EnvVar[], component: ComponentSpec, runtime: RenderRuntime): EnvVar[] {
  const vars = new Map<string, string>();
  for (const { key, value } of projectEnv) {
    if (KEY.test(key)) vars.set(key, value);
  }

  const version = component.nodeVersion?.trim() ?? "";
  if (runtime === "node" && !vars.has("NODE_VERSION")) {
    const major = /(\d+)/.exec(version)?.[1];
    if (major) vars.set("NODE_VERSION", major);
  }
  if (runtime === "python" && !vars.has("PYTHON_VERSION")) {
    const full = /(\d+\.\d+\.\d+)/.exec(version)?.[1];
    if (full) vars.set("PYTHON_VERSION", full);
  }

  return [...vars].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }));
}

/** Hash of keys and values, so an unchanged set skips every env call. Values never leave this function. */
export function envHash(vars: EnvVar[]): string {
  const hash = createHash("sha256");
  for (const { key, value } of [...vars].sort((a, b) => a.key.localeCompare(b.key))) {
    hash.update(key).update("\0").update(value).update("\0");
  }
  return hash.digest("hex");
}

/**
 * Keys to delete on Render: ones this service set before that are no longer
 * wanted. Anything added by hand on Render's dashboard was never "managed",
 * so it is never deleted.
 */
export function keysToDelete(previouslyManaged: string[], next: EnvVar[]): string[] {
  const keep = new Set(next.map((v) => v.key));
  return previouslyManaged.filter((key) => !keep.has(key));
}
