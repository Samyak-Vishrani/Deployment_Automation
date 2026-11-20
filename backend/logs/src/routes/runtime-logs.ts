import type { RuntimeLogEvent } from "@orbitops/integration-common/contract";
import { pipeNdjson } from "@orbitops/integration-common/ndjson";
import { badRequest, notFound } from "@orbitops/integration-common/provider-error";
import type { FastifyInstance } from "fastify";
import type { NdjsonSink } from "@orbitops/integration-common/ndjson";
import { assertId } from "../entries/ingest-input";
import type { RuntimeSessions } from "../runtime/runtime-session";

/** Builds a tailer for one viewer; the signal stops it. */
export interface Tailers {
  vercel(userId: string, componentId: string, signal: AbortSignal): AsyncGenerator<RuntimeLogEvent>;
  render(userId: string, componentId: string, opts: { sinceMs: number; includeRequests: boolean }, signal: AbortSignal): AsyncGenerator<RuntimeLogEvent>;
  docker(containerName: string, opts: { sinceMs: number }, signal: AbortSignal): AsyncGenerator<RuntimeLogEvent>;
}

export interface RuntimeDeps {
  sessions: RuntimeSessions;
  tailers: Tailers;
}

const SINCE: Record<string, number> = { "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000 };

export function parseSince(value: unknown): number {
  if (value === undefined || value === "") return SINCE["15m"];
  if (typeof value === "string" && value in SINCE) return SINCE[value];
  throw badRequest("since must be 5m, 15m or 1h.");
}

type ComponentStream = {
  Params: { componentId: string };
  Querystring: { userId?: string; provider?: string; since?: string; requests?: string };
};
type DockerStream = { Params: { containerName: string }; Querystring: { userId?: string; since?: string } };

/**
 * Live runtime logs, as NDJSON RuntimeLogEvents. The session id comes back in
 * `x-session-id`; the viewer pings it to keep the stream from ending "idle".
 * Nothing is stored: the stream lives exactly as long as the request.
 */
export function registerRuntimeRoutes(app: FastifyInstance, deps: RuntimeDeps, heartbeatMs: number): void {
  const stream = async (
    reply: { hijack(): unknown; raw: NdjsonSink },
    userId: string,
    source: (signal: AbortSignal) => AsyncGenerator<RuntimeLogEvent>,
  ) => {
    const session = await deps.sessions.open(userId, source);
    reply.hijack();
    await pipeNdjson(reply.raw, session.events, {
      heartbeatMs,
      headers: { "x-session-id": session.sessionId },
      onClose: session.abort,
    });
  };

  app.get<ComponentStream>("/runtime/components/:componentId/stream", async (request, reply) => {
    const componentId = assertId(request.params.componentId, "componentId");
    const userId = assertId(request.query.userId, "userId");
    const sinceMs = parseSince(request.query.since);
    const includeRequests = request.query.requests === "1" || request.query.requests === "true";
    const provider = request.query.provider;
    if (provider === "vercel") {
      return stream(reply, userId, (signal) => deps.tailers.vercel(userId, componentId, signal));
    }
    if (provider === "render") {
      return stream(reply, userId, (signal) => deps.tailers.render(userId, componentId, { sinceMs, includeRequests }, signal));
    }
    throw badRequest("provider must be vercel or render.");
  });

  app.get<DockerStream>("/runtime/docker/:containerName/stream", async (request, reply) => {
    const userId = assertId(request.query.userId, "userId");
    const sinceMs = parseSince(request.query.since);
    const containerName = request.params.containerName;
    return stream(reply, userId, (signal) => deps.tailers.docker(containerName, { sinceMs }, signal));
  });

  app.post<{ Params: { sessionId: string } }>("/runtime/sessions/:sessionId/ping", async (request) => {
    if (!deps.sessions.ping(request.params.sessionId)) throw notFound("That log stream has ended.");
    return { ok: true };
  });
}
