/**
 * What an environment variable may look like, per provider (Phase 9).
 *
 * Pure. Every message names the KEY and never the value: values are often
 * secrets, and an error message travels to the browser and into logs.
 *
 * Checked against the providers' docs on 2026-11-03 (PLAN_PHASE_9 step 0):
 * - Vercel: a total of 64 KB of env vars per deployment, so no single value
 *   can be larger. "Secret" vars are API type "sensitive", write-only after
 *   saving, and now allowed in every target. A saved Secret cannot be turned
 *   into a Config var in place: it has to be deleted and created again.
 *   Reserved (Vercel Function runtimes): AWS_SECRET_KEY, AWS_EXECUTION_ENV,
 *   AWS_LAMBDA_LOG_GROUP_NAME, AWS_LAMBDA_LOG_STREAM_NAME,
 *   AWS_LAMBDA_FUNCTION_NAME, AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
 *   AWS_LAMBDA_FUNCTION_VERSION, NOW_REGION, TZ, LAMBDA_TASK_ROOT,
 *   LAMBDA_RUNTIME_DIR. VERCEL_* are Vercel's system variables.
 * - Render: no documented size limit for plain env vars (secret FILES are
 *   capped at 1 MB). It sets RENDER and RENDER_* itself ("other variables
 *   starting with RENDER_ might be present"), so those are refused. NODE_ENV,
 *   PORT, NODE_VERSION and the like may be set: they change Render's defaults.
 */

import type { ComponentKind, ProviderId } from "@prisma/client";

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_KEY_LENGTH = 255;
/** Per value. Multi-line values (PEM keys) are fine. */
export const MAX_VALUE_BYTES = 32 * 1024;
/** Vercel's 64 KB per deployment, less room for the API URL we add. */
export const MAX_VERCEL_TOTAL_BYTES = 60 * 1024;
export const MAX_VARS_PER_SCOPE = 100;

const SECRET_WORDS = /SECRET|TOKEN|KEY|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|DATABASE_URL|DSN|AUTH/;

/**
 * Prefixes frameworks inline into browser code at build time. A variable with
 * one of these on a frontend is public by construction.
 */
export const PUBLIC_PREFIXES = ["NEXT_PUBLIC_", "NUXT_PUBLIC_", "VITE_", "REACT_APP_", "PUBLIC_", "EXPO_PUBLIC_", "GATSBY_"];

const VERCEL_RESERVED = new Set([
  "AWS_SECRET_KEY",
  "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_LOG_GROUP_NAME",
  "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "NOW_REGION",
  "TZ",
  "LAMBDA_TASK_ROOT",
  "LAMBDA_RUNTIME_DIR",
]);

/** A guess for imports (paste a .env, add from .env.example). The user can change it. */
export function looksSecret(key: string): boolean {
  const upper = key.toUpperCase();
  if (isPublicKey(upper)) return false;
  return SECRET_WORDS.test(upper);
}

export function isPublicKey(key: string): boolean {
  const upper = key.toUpperCase();
  return PUBLIC_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Why the provider will not take this key, or null. */
export function reservedReason(key: string, provider: ProviderId | null): string | null {
  const upper = key.toUpperCase();
  if (provider === "vercel") {
    if (VERCEL_RESERVED.has(upper)) return `${key} is reserved by Vercel's runtime`;
    if (upper.startsWith("VERCEL_")) return `${key} is one of Vercel's system variables (VERCEL_*)`;
  }
  if (provider === "render") {
    if (upper === "RENDER" || upper.startsWith("RENDER_")) return `${key} is set by Render itself (RENDER_*)`;
  }
  return null;
}

/** Where a set of variables goes: one component, or "shared" (every backend + local Docker). */
export type EnvScope =
  | { kind: "shared" }
  | { kind: ComponentKind; provider: ProviderId; name: string };

export type EnvEntry = { key: string; isSecret: boolean; value?: string };

/**
 * Validates a whole scope's set. Values are checked only where given (a kept
 * secret is not re-sent). Returns the first problem as a sentence, or null.
 */
export function envProblem(entries: EnvEntry[], scope: EnvScope): string | null {
  if (scope.kind === "database") {
    return "A database has no env vars: its connection string goes to the backend as DATABASE_URL.";
  }
  if (entries.length > MAX_VARS_PER_SCOPE) {
    return `At most ${MAX_VARS_PER_SCOPE} variables per component; this set has ${entries.length}.`;
  }

  // Shared vars reach the backends (Render) and local Docker, never a frontend.
  const providers: (ProviderId | null)[] = scope.kind === "shared" ? ["render", "local_docker"] : [scope.provider];
  const seen = new Set<string>();
  let vercelTotal = 0;

  for (const entry of entries) {
    const { key } = entry;
    if (!key || key.length > MAX_KEY_LENGTH || !ENV_KEY.test(key)) {
      return `"${key.slice(0, 60)}" is not a valid variable name: use letters, digits and _, not starting with a digit.`;
    }
    if (seen.has(key)) return `${key} is set twice.`;
    seen.add(key);

    for (const provider of providers) {
      const reason = reservedReason(key, provider);
      if (reason) return `${reason}, so it cannot be set here.`;
    }

    if (scope.kind === "frontend" && entry.isSecret && isPublicKey(key)) {
      return (
        `${key} cannot be a secret: its prefix makes the framework inline it into browser code, ` +
        "where anyone can read it. Untick Secret, or rename it."
      );
    }

    if (entry.value !== undefined) {
      const bytes = Buffer.byteLength(entry.value, "utf8");
      if (bytes > MAX_VALUE_BYTES) return `${key} is ${Math.ceil(bytes / 1024)} KB; the limit is ${MAX_VALUE_BYTES / 1024} KB.`;
      if (entry.value.includes("\0")) return `${key} contains a NUL character.`;
      vercelTotal += bytes + Buffer.byteLength(key, "utf8");
    }
  }

  if (scope.kind !== "shared" && scope.provider === "vercel" && vercelTotal > MAX_VERCEL_TOTAL_BYTES) {
    return `These variables add up to ${Math.ceil(vercelTotal / 1024)} KB; Vercel allows 64 KB per deployment in total.`;
  }
  return null;
}
