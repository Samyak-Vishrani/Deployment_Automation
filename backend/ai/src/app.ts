import { INTERNAL_TOKEN_HEADER, isValidInternalToken } from "@orbitops/integration-common/internal-auth";
import { badRequest, ProviderError, ServiceError } from "@orbitops/integration-common/provider-error";
import Fastify, { type FastifyInstance } from "fastify";
import { assertId, parseAnalyzeRequest } from "./analysis/analysis-input";
import type { AnalysisService } from "./analysis/analysis.service";

export interface AppDeps {
  serviceToken: string;
  analyses: Pick<AnalysisService, "analyze" | "list" | "get" | "feedback" | "engine">;
  checkDatabase?: () => Promise<boolean>;
  logger?: boolean;
}

/**
 * The internal HTTP API (Phase 13). Only the main backend calls it, with
 * x-internal-token (AI_SERVICE_TOKEN). The backend checks the user owns the
 * project and builds the context bundle; this service never sees a browser,
 * the main database, or an env var value.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    // Request logs never include bodies (the bundle holds log lines).
    logger: deps.logger ? { redact: [`req.headers["${INTERNAL_TOKEN_HEADER}"]`] } : false,
    bodyLimit: 4 * 1024 * 1024,
  });

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
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "bad_request", message: (error as Error).message });
    }
    console.error("[api] Unhandled error:", (error as Error).message);
    return reply.code(500).send({ error: "internal_server_error", message: "The AI service hit an unexpected error." });
  });

  app.get("/health", async (_request, reply) => {
    const database = deps.checkDatabase ? await deps.checkDatabase().catch(() => false) : true;
    return reply.code(database ? 200 : 503).send({ status: database ? "ok" : "degraded", database, ...deps.analyses.engine });
  });

  app.post("/analyses", async (request) => deps.analyses.analyze(parseAnalyzeRequest(request.body)));

  app.get<{ Querystring: { userId?: string; projectId?: string; take?: string } }>("/analyses", async (request) =>
    deps.analyses.list(assertId(request.query.userId, "userId"), assertId(request.query.projectId, "projectId"), Number(request.query.take ?? 10) || 10),
  );

  app.get<{ Params: { id: string }; Querystring: { userId?: string } }>("/analyses/:id", async (request) =>
    deps.analyses.get(assertId(request.query.userId, "userId"), assertId(request.params.id, "id")),
  );

  app.post<{ Params: { id: string } }>("/analyses/:id/feedback", async (request) => {
    const body = (request.body ?? {}) as { userId?: unknown; helpful?: unknown };
    if (typeof body.helpful !== "boolean") throw badRequest("helpful must be true or false.");
    return deps.analyses.feedback(assertId(body.userId, "userId"), assertId(request.params.id, "id"), body.helpful);
  });

  return app;
}
