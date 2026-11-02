import { badRequest } from "../http/provider-error";
import { PLANS, REGIONS } from "../render/service-settings";

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

/** A Render API key: one line, no spaces. Never echoed back in an error. */
export function parseKeyInput(raw: unknown): { apiKey: string } {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["apiKey"]);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    throw badRequest("Paste a Render API key.");
  }
  if (apiKey.length > 200 || /\s/.test(apiKey)) {
    throw badRequest("That does not look like a Render API key (one line, no spaces, at most 200 characters).");
  }
  return { apiKey };
}

export interface Preferences {
  ownerId?: string;
  region?: string;
  plan?: string;
}

export function parsePreferencesInput(raw: unknown): Preferences {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["ownerId", "region", "plan"]);
  const out: Preferences = {};
  if (body.ownerId !== undefined) {
    if (typeof body.ownerId !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(body.ownerId)) {
      throw badRequest("ownerId must be a Render workspace id.");
    }
    out.ownerId = body.ownerId;
  }
  if (body.region !== undefined) {
    if (typeof body.region !== "string" || !(REGIONS as readonly string[]).includes(body.region)) {
      throw badRequest(`region must be one of ${REGIONS.join(", ")}.`);
    }
    out.region = body.region;
  }
  if (body.plan !== undefined) {
    if (typeof body.plan !== "string" || !(PLANS as readonly string[]).includes(body.plan)) {
      throw badRequest(`plan must be one of ${PLANS.join(", ")}.`);
    }
    out.plan = body.plan;
  }
  if (Object.keys(out).length === 0) {
    throw badRequest("Send at least one of ownerId, region or plan.");
  }
  return out;
}

/** Ids the main backend passes in paths: cuids, but anything id-like is accepted. */
export function assertId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw badRequest(`${label} is not a valid id.`);
  }
  return value;
}
