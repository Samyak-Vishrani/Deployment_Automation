import { badRequest } from "@/lib/api/http-error";
import type { EventBatch, ProviderEvent } from "./vercel-service.types";

const EVENT_TYPES = new Set(["status", "resource", "deployment", "logs", "terminal"]);
const MAX_EVENTS = 500;

/**
 * Structural check of a callback body. The sender is authenticated by HMAC, so
 * this guards against contract drift between the two services, not attackers:
 * a malformed batch is a 400 the sender will not retry.
 */
export function parseEventBatch(raw: unknown): EventBatch {
  const body = raw as Partial<EventBatch> | null;
  if (!body || typeof body !== "object") throw badRequest("Body must be an event batch.");
  if (typeof body.deploymentId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.deploymentId)) {
    throw badRequest("deploymentId must be an id.");
  }
  if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 1) {
    throw badRequest("seq must be a positive integer.");
  }
  if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS) {
    throw badRequest(`events must be an array of at most ${MAX_EVENTS}.`);
  }
  for (const event of body.events) {
    if (!event || typeof event !== "object" || !EVENT_TYPES.has((event as ProviderEvent).type)) {
      throw badRequest("Unknown event type.");
    }
    if ((event as ProviderEvent).type === "logs" && !Array.isArray((event as { lines?: unknown }).lines)) {
      throw badRequest("A logs event needs lines.");
    }
  }
  return { deploymentId: body.deploymentId, seq: body.seq, events: body.events as ProviderEvent[] };
}
