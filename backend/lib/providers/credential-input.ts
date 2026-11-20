import type { ProviderId } from "@prisma/client";
import { badRequest } from "@/lib/api/http-error";
import { PROVIDER_IDS, PROVIDER_LABEL, PROVIDER_PHASE } from "@/lib/components/provider-rules";
import { asObject, rejectUnknownKeys } from "@/lib/projects/project-input";

/**
 * Light checks before a credential request is forwarded to the integration
 * service, which validates fully. The token itself never appears in an error.
 */

export type ConnectableProvider = "vercel" | "render" | "neon";

export function parseProviderParam(value: string): ConnectableProvider {
  if (!(PROVIDER_IDS as readonly string[]).includes(value) || value === "local_docker") {
    throw badRequest(`Unknown provider "${value}".`);
  }
  if (value !== "vercel" && value !== "render" && value !== "neon") {
    const provider = value as ProviderId;
    throw badRequest(`Connecting ${PROVIDER_LABEL[provider]} arrives in Phase ${PROVIDER_PHASE[provider]}.`);
  }
  return value;
}

/** Render settings: `{ ownerId?, region?, plan? }`. The service validates the values. */
export function parseRenderPrefsBody(raw: unknown): { ownerId?: string; region?: string; plan?: string } {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["ownerId", "region", "plan"]);
  const out: { ownerId?: string; region?: string; plan?: string } = {};
  for (const key of ["ownerId", "region", "plan"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string" || !body[key]) {
      throw badRequest(`${key} must be a non-empty string.`);
    }
    out[key] = body[key] as string;
  }
  if (Object.keys(out).length === 0) {
    throw badRequest("Send at least one of ownerId, region or plan.");
  }
  return out;
}

/** Neon settings: `{ orgId?, regionId?, pgVersion? }`. The service validates the values. */
export function parseNeonPrefsBody(raw: unknown): { orgId?: string | null; regionId?: string; pgVersion?: number } {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["orgId", "regionId", "pgVersion"]);
  const out: { orgId?: string | null; regionId?: string; pgVersion?: number } = {};
  if (body.orgId !== undefined) {
    if (body.orgId !== null && (typeof body.orgId !== "string" || !body.orgId)) {
      throw badRequest("orgId must be a Neon organization id, or null for the key's default.");
    }
    out.orgId = body.orgId as string | null;
  }
  if (body.regionId !== undefined) {
    if (typeof body.regionId !== "string" || !body.regionId) throw badRequest("regionId must be a Neon region id.");
    out.regionId = body.regionId;
  }
  if (body.pgVersion !== undefined) {
    if (typeof body.pgVersion !== "number" || !Number.isInteger(body.pgVersion)) {
      throw badRequest("pgVersion must be a Postgres major version, e.g. 17.");
    }
    out.pgVersion = body.pgVersion;
  }
  if (Object.keys(out).length === 0) {
    throw badRequest("Send at least one of orgId, regionId or pgVersion.");
  }
  return out;
}

export function parseTokenBody(raw: unknown): { token: string } {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["token"]);
  if (typeof body.token !== "string" || !body.token.trim()) {
    throw badRequest("Paste an access token or API key.");
  }
  return { token: body.token.trim() };
}

export function parseTeamBody(raw: unknown): { teamId: string | null } {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["teamId"]);
  if (body.teamId !== null && typeof body.teamId !== "string") {
    throw badRequest("teamId must be a Vercel team id, or null for your personal scope.");
  }
  return { teamId: body.teamId as string | null };
}
