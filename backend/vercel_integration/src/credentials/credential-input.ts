import { badRequest } from "../http/provider-error";

/**
 * Hand-written validators in the style of backend/lib/projects/project-input.ts:
 * unknown keys are rejected, so a typo cannot silently do nothing.
 */

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw badRequest(`Unknown field(s): ${unknown.join(", ")}.`);
  }
}

/** A Vercel access token: one line, no spaces. Never echoed back in an error. */
export function parseTokenInput(raw: unknown): { token: string } {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["token"]);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    throw badRequest("Paste a Vercel access token.");
  }
  if (token.length > 200 || /\s/.test(token)) {
    throw badRequest("That does not look like a Vercel access token (one line, no spaces, at most 200 characters).");
  }
  return { token };
}

export function parseTeamInput(raw: unknown): { teamId: string | null } {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["teamId"]);
  if (body.teamId === null) return { teamId: null };
  if (typeof body.teamId !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(body.teamId)) {
    throw badRequest("teamId must be a Vercel team id, or null for your personal scope.");
  }
  return { teamId: body.teamId };
}

/** Ids the main backend passes in paths: cuids, but anything id-like is accepted. */
export function assertId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw badRequest(`${label} is not a valid id.`);
  }
  return value;
}
