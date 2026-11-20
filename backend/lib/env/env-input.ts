import { badRequest } from "@/lib/api/http-error";
import { MAX_VARS_PER_SCOPE } from "./env-rules";

/**
 * One row of a PUT. `value` omitted = keep the stored value (a secret is never
 * sent back to the browser, so it cannot be re-sent). A new key needs one.
 */
export type EnvPutEntry = { key: string; value?: string; isSecret: boolean };
export type EnvPutInput = { vars: EnvPutEntry[] };

/**
 * Body of `PUT …/env`: `{ vars: [{ key, value?, isSecret? }] }`, the whole set
 * for the scope (keys left out are deleted). Messages name keys, never values.
 */
export function parseEnvPut(body: unknown): EnvPutInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest('Send a JSON object: { "vars": [{ "key", "value", "isSecret" }] }.');
  }
  const raw = (body as Record<string, unknown>).vars;
  if (!Array.isArray(raw)) throw badRequest("vars must be an array.");
  if (raw.length > MAX_VARS_PER_SCOPE) {
    throw badRequest(`At most ${MAX_VARS_PER_SCOPE} variables per component; got ${raw.length}.`);
  }

  const seen = new Set<string>();
  const vars = raw.map((item, index): EnvPutEntry => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw badRequest(`vars[${index}] must be an object.`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.key !== "string" || entry.key.trim() === "") {
      throw badRequest(`vars[${index}].key must be a non-empty string.`);
    }
    const key = entry.key.trim();
    if (seen.has(key)) throw badRequest(`${key} is set twice.`);
    seen.add(key);

    if (entry.value !== undefined && entry.value !== null && typeof entry.value !== "string") {
      throw badRequest(`${key}: value must be a string.`);
    }
    if (entry.isSecret !== undefined && typeof entry.isSecret !== "boolean") {
      throw badRequest(`${key}: isSecret must be true or false.`);
    }
    return {
      key,
      ...(typeof entry.value === "string" && { value: entry.value }),
      isSecret: entry.isSecret ?? true,
    };
  });
  return { vars };
}
