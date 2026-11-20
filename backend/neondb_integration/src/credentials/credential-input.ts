import { badRequest } from "@orbitops/integration-common/provider-error";
import { isPgVersion, isRegionId, PG_VERSIONS, REGION_IDS } from "../neon/regions";

/**
 * Hand-written validators in the style of backend/lib/projects/project-input.ts:
 * unknown keys are rejected, so a typo cannot silently do nothing.
 */

export function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw badRequest(`Unknown field(s): ${unknown.join(", ")}.`);
  }
}

/** A Neon API key: one line, no spaces. Never echoed back in an error. */
export function parseKeyInput(raw: unknown): { apiKey: string } {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["apiKey"]);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    throw badRequest("Paste a Neon API key.");
  }
  if (apiKey.length > 300 || /\s/.test(apiKey)) {
    throw badRequest("That does not look like a Neon API key (one line, no spaces, at most 300 characters).");
  }
  return { apiKey };
}

export interface Preferences {
  /** null: the key's default organization. */
  orgId?: string | null;
  regionId?: string;
  pgVersion?: number;
}

export function parsePreferencesInput(raw: unknown): Preferences {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["orgId", "regionId", "pgVersion"]);
  const out: Preferences = {};
  if (body.orgId !== undefined) {
    if (body.orgId !== null && (typeof body.orgId !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(body.orgId))) {
      throw badRequest("orgId must be a Neon organization id, or null for the key's default.");
    }
    out.orgId = body.orgId as string | null;
  }
  if (body.regionId !== undefined) {
    if (!isRegionId(body.regionId)) {
      throw badRequest(`regionId must be one of ${REGION_IDS.join(", ")}.`);
    }
    out.regionId = body.regionId;
  }
  if (body.pgVersion !== undefined) {
    if (!isPgVersion(body.pgVersion)) {
      throw badRequest(`pgVersion must be one of ${PG_VERSIONS.join(", ")}.`);
    }
    out.pgVersion = body.pgVersion;
  }
  if (Object.keys(out).length === 0) {
    throw badRequest("Send at least one of orgId, regionId or pgVersion.");
  }
  return out;
}

/** Ids the main backend passes in paths and bodies: cuids, but anything id-like is accepted. */
export function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw badRequest(`${label} is not a valid id.`);
  }
  return value;
}
