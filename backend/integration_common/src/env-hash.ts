import { createHash } from "node:crypto";

/**
 * Hash of a set of env vars, so an unchanged set (the usual redeploy) costs no
 * provider API call. Values go into the hash and nowhere else.
 *
 * A `secret` flag, when present, is part of the hash: on Vercel a variable
 * that turns from Config into Secret has to be deleted and created again.
 * Without the flag the hash is the one render_integration has stored since
 * Phase 7, so existing services are not re-synced for nothing.
 */
export function envHash(vars: Array<{ key: string; value: string; secret?: boolean }>): string {
  const hash = createHash("sha256");
  for (const v of [...vars].sort((a, b) => a.key.localeCompare(b.key))) {
    hash.update(v.key).update("\0").update(v.value).update("\0");
    if (v.secret !== undefined) hash.update(v.secret ? "s" : "c").update("\0");
  }
  return hash.digest("hex");
}

/**
 * Keys to delete on the provider: ones this service set before that are no
 * longer wanted. Anything added by hand on the provider's dashboard was never
 * "managed", so it is never deleted.
 */
export function keysToDelete<T extends { key: string }>(previouslyManaged: unknown, next: T[]): string[] {
  const keep = new Set(next.map((v) => v.key));
  return (Array.isArray(previouslyManaged) ? previouslyManaged : [])
    .map((entry: unknown) => (typeof entry === "string" ? entry : (entry as { key?: unknown } | null)?.key))
    .filter((key): key is string => typeof key === "string")
    .filter((key) => !keep.has(key));
}
