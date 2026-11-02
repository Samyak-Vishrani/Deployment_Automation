import type { ProviderId } from "@prisma/client";
import { badRequest } from "@/lib/api/http-error";
import { PROVIDER_IDS, PROVIDER_LABEL, PROVIDER_PHASE } from "@/lib/components/provider-rules";
import { asObject, rejectUnknownKeys } from "@/lib/projects/project-input";

/**
 * Light checks before a credential request is forwarded to the integration
 * service, which validates fully. The token itself never appears in an error.
 */

export function parseProviderParam(value: string): "vercel" {
  if (!(PROVIDER_IDS as readonly string[]).includes(value) || value === "local_docker") {
    throw badRequest(`Unknown provider "${value}".`);
  }
  if (value !== "vercel") {
    const provider = value as ProviderId;
    throw badRequest(`Connecting ${PROVIDER_LABEL[provider]} arrives in Phase ${PROVIDER_PHASE[provider]}.`);
  }
  return value;
}

export function parseTokenBody(raw: unknown): { token: string } {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["token"]);
  if (typeof body.token !== "string" || !body.token.trim()) {
    throw badRequest("Paste a Vercel access token.");
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
