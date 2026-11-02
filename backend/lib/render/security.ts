import { HttpError, badRequest } from "@/lib/api/http-error";
import prisma from "@/lib/db/prisma";
import { redact } from "@/lib/common/redact";
import { normalizeLogs } from "@/lib/log-analysis/log-normalizer";

export function requireTrustedOrigin(request: Request) {
  const allowed = process.env.FRONTEND_URL ?? (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : "");
  const origin = request.headers.get("origin");
  if (!allowed || origin !== new URL(allowed).origin) {
    throw new HttpError("Request origin is not allowed.", 403, "invalid_origin");
  }
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw badRequest("JSON request required.");
  const reader = request.body?.getReader();
  if (!reader) throw badRequest("Request body required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) { await reader.cancel(); throw new HttpError("Request is too large.", 413); }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Expected a JSON object.");
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badRequest("Invalid JSON.");
  } finally { reader.releaseLock(); }
}

export function textField(body: Record<string, unknown>, key: string, max = 200): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw badRequest(`Invalid ${key}.`);
  return value.trim();
}

export function parseEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("envVars must be an object.");
  const entries = Object.entries(value);
  if (entries.length > 100) throw badRequest("At most 100 environment variables are supported.");
  for (const [key, val] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || typeof val !== "string" || val.length > 10000 || val.includes("\0")) throw badRequest("Invalid environment variable name or value.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** A shared database limiter works across server instances and process restarts. */
export async function rateLimit(userId: string, operation: string, limit: number) {
  const window = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const key = `${userId}:${operation}`;
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RenderRateLimit" ("key", "window", "count") VALUES (${key}, ${window}, 1)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RenderRateLimit"."window" = EXCLUDED."window" THEN "RenderRateLimit"."count" + 1 ELSE 1 END,
      "window" = EXCLUDED."window" RETURNING "count"`;
  if (rows[0].count > limit) throw new HttpError("Too many requests. Wait a minute and try again.", 429, "rate_limited");
}

export function scrubLogs(logs: string, secrets: string[]): string {
  // Include short secrets too; avoiding disclosure takes precedence over prettiness.
  let safe = redact(logs).replace(/\b(?:rnd_|gsk_)[A-Za-z0-9_-]+/g, "[REDACTED]");
  for (const value of [...secrets].filter(Boolean).sort((a,b) => b.length - a.length)) {
    safe = safe.split(value).join("[REDACTED]");
  }
  return normalizeLogs({ source: "deployment", logType: "deployment", projectName: "", logs: safe }).logs.slice(-60_000);
}
