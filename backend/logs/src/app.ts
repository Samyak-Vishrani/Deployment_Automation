import { INTERNAL_TOKEN_HEADER, isValidInternalToken } from "@orbitops/integration-common/internal-auth";
import { pipeNdjson } from "@orbitops/integration-common/ndjson";
import { ProviderError, ServiceError } from "@orbitops/integration-common/provider-error";
import Fastify, { type FastifyInstance } from "fastify";
import { entryToText } from "./entries/entry-text";
import { assertId, intQuery, parseIngest } from "./entries/ingest-input";
import { buildLogStream } from "./routes/build-stream";
import { registerRuntimeRoutes, type RuntimeDeps } from "./routes/runtime-logs";
import { InvalidLogIdError, type LogStore } from "./store/log-store";

export interface AppDeps {
  serviceToken: string;
  store: LogStore;
  /** Runtime tailing (Vercel, Render, Docker). Absent in tests that only cover build logs. */
  runtime?: RuntimeDeps;
  heartbeatMs?: number;
  logger?: boolean;
}

type DeploymentRoute = { Params: { deploymentId: string } };
type ReadQuery = { Querystring: { projectId?: string; afterSeq?: string; limit?: string } };

/**
 * The internal HTTP API. Only the main backend calls it: every route except
 * /health needs x-internal-token (LOGS_SERVICE_TOKEN). The backend checks the
 * user owns the deployment or component before it calls; this service trusts
 * the ids it is given and never sees a browser.
 *
 * Every route is about ONE deployment or ONE component. Nothing here merges
 * logs of several: the combined log is Phase 13's, built from these reads.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ? { redact: [`req.headers["${INTERNAL_TOKEN_HEADER}"]`] } : false,
    // 500 entries of up to 16 KB each, JSON-encoded.
    bodyLimit: 10 * 1024 * 1024,
  });
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (!isValidInternalToken(deps.serviceToken, request.headers[INTERNAL_TOKEN_HEADER])) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing or wrong internal service token." });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProviderError || error instanceof ServiceError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    if (error instanceof InvalidLogIdError) {
      return reply.code(400).send({ error: "bad_request", message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "bad_request", message: (error as Error).message });
    }
    console.error("[api] Unhandled error:", (error as Error).message);
    return reply.code(500).send({ error: "internal_server_error", message: "The logs service hit an unexpected error." });
  });

  app.get("/health", async () => ({ status: "ok" }));

  // ----------------------------------------------------------- build logs --

  app.post<DeploymentRoute>("/deployments/:deploymentId/entries", async (request) => {
    const deploymentId = assertId(request.params.deploymentId, "deploymentId");
    return deps.store.append(deploymentId, parseIngest(request.body));
  });

  app.post<DeploymentRoute>("/deployments/:deploymentId/close", async (request) => {
    const deploymentId = assertId(request.params.deploymentId, "deploymentId");
    const body = (request.body ?? {}) as { projectId?: unknown; status?: unknown };
    const projectId = assertId(body.projectId, "projectId");
    const status = typeof body.status === "string" && body.status.length <= 20 ? body.status : "finished";
    return deps.store.close(deploymentId, projectId, status);
  });

  app.get<DeploymentRoute & ReadQuery>("/deployments/:deploymentId/entries", async (request) => {
    const deploymentId = assertId(request.params.deploymentId, "deploymentId");
    const projectId = assertId(request.query.projectId, "projectId");
    return deps.store.read(deploymentId, projectId, {
      afterSeq: intQuery(request.query.afterSeq, 0),
      limit: intQuery(request.query.limit, 5000, 5000),
    });
  });

  app.get<DeploymentRoute & ReadQuery>("/deployments/:deploymentId/text", async (request, reply) => {
    const deploymentId = assertId(request.params.deploymentId, "deploymentId");
    const projectId = assertId(request.query.projectId, "projectId");
    const { entries } = await deps.store.read(deploymentId, projectId, { limit: Number.MAX_SAFE_INTEGER });
    reply.header("content-type", "text/plain; charset=utf-8");
    return entries.map(entryToText).join("\n") + (entries.length ? "\n" : "");
  });

  /** NDJSON: {type:"entry",entry}…, then {type:"done",status}; heartbeats in between. */
  app.get<DeploymentRoute & ReadQuery>("/deployments/:deploymentId/stream", async (request, reply) => {
    const deploymentId = assertId(request.params.deploymentId, "deploymentId");
    const projectId = assertId(request.query.projectId, "projectId");
    const afterSeq = intQuery(request.query.afterSeq, 0);
    const abort = new AbortController();
    reply.hijack();
    await pipeNdjson(reply.raw, buildLogStream(deps.store, deploymentId, projectId, afterSeq, abort.signal), {
      heartbeatMs,
      onClose: () => abort.abort(),
    });
  });

  // -------------------------------------------------------- runtime logs --
  if (deps.runtime) registerRuntimeRoutes(app, deps.runtime, heartbeatMs);

  return app;
}
