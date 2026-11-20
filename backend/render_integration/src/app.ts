import Fastify, { type FastifyInstance } from "fastify";
import { INTERNAL_TOKEN_HEADER, isValidInternalToken } from "@orbitops/integration-common/internal-auth";
import { ProviderError, ServiceError } from "@orbitops/integration-common/provider-error";
import { assertId, parseKeyInput, parsePreferencesInput } from "./credentials/credential-input";
import type { CredentialsService } from "./credentials/credentials.service";
import { parseDeployRequest, parseEnvVarsBody, parseRollbackBody } from "./deployments/deploy-input";
import type { DeploymentsService } from "./deployments/deployments.service";
import { LOGS_PROXY_HEADER, type RenderLogProxy } from "./log-proxy/log-proxy";

export interface AppDeps {
  serviceToken: string;
  credentials: Pick<CredentialsService, "get" | "save" | "setPreferences" | "remove">;
  deployments: Pick<
    DeploymentsService,
    "start" | "get" | "listActive" | "cancel" | "setEnv" | "rollback" | "destroyService"
  >;
  /** Liveness of the database, for /health. */
  checkDatabase?: () => Promise<boolean>;
  /** Phase 12: read-only log pages for backend/logs, behind its own token. */
  logProxy?: Pick<RenderLogProxy, "logsPage">;
  /** LOGS_PROXY_TOKEN; accepted on /log-proxy routes only. Unset = those routes are off. */
  logsProxyToken?: string;
  logger?: boolean;
}

/**
 * The internal HTTP API. Only the main backend talks to it: every route except
 * /health requires the shared x-internal-token (RENDER_SERVICE_TOKEN), and the
 * main backend always passes the userId it authenticated, so this service
 * never sees a browser.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger
      ? { redact: ["req.headers.authorization", `req.headers["${INTERNAL_TOKEN_HEADER}"]`, `req.headers["${LOGS_PROXY_HEADER}"]`] }
      : false,
    bodyLimit: 1024 * 1024,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    // The logs service's door: its own token, and only this one prefix. The
    // internal token does not open it, and its token opens nothing else.
    if (request.url.startsWith("/log-proxy/")) {
      if (!deps.logsProxyToken || !deps.logProxy) {
        return reply.code(503).send({ error: "log_proxy_disabled", message: "LOGS_PROXY_TOKEN is not set in render_integration/.env." });
      }
      if (!isValidInternalToken(deps.logsProxyToken, request.headers[LOGS_PROXY_HEADER])) {
        return reply.code(401).send({ error: "unauthorized", message: "Missing or wrong logs proxy token." });
      }
      return;
    }
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
    console.error("[api] Unhandled error:", error);
    return reply
      .code(500)
      .send({ error: "internal_server_error", message: "The Render integration hit an unexpected error." });
  });

  // --------------------------------------------------------------- health --
  app.get("/health", async (_request, reply) => {
    const database = deps.checkDatabase ? await deps.checkDatabase().catch(() => false) : true;
    return reply.code(database ? 200 : 503).send({ status: database ? "ok" : "degraded", database });
  });

  // ---------------------------------------------------------- credentials --
  type UserParams = { Params: { userId: string } };

  app.get<UserParams>("/users/:userId/credential", async (request) =>
    deps.credentials.get(assertId(request.params.userId, "userId")),
  );

  app.put<UserParams>("/users/:userId/credential", async (request) => {
    const { apiKey } = parseKeyInput(request.body);
    return deps.credentials.save(assertId(request.params.userId, "userId"), apiKey);
  });

  /** `{ ownerId?, region?, plan? }`: the workspace and the defaults for new services. */
  app.patch<UserParams>("/users/:userId/credential", async (request) =>
    deps.credentials.setPreferences(assertId(request.params.userId, "userId"), parsePreferencesInput(request.body)),
  );

  app.delete<UserParams>("/users/:userId/credential", async (request) =>
    deps.credentials.remove(assertId(request.params.userId, "userId")),
  );

  // ---------------------------------------------------------- deployments --
  type DeploymentParams = { Params: { deploymentId: string } };

  app.post("/deployments", async (request, reply) => {
    const view = await deps.deployments.start(parseDeployRequest(request.body));
    return reply.code(202).send(view);
  });

  app.get<{ Querystring: { state?: string } }>("/deployments", async (request) => {
    if (request.query.state !== "active") {
      throw new ServiceError("Only ?state=active is supported.", 400, "bad_request");
    }
    return deps.deployments.listActive();
  });

  app.get<DeploymentParams>("/deployments/:deploymentId", async (request) =>
    deps.deployments.get(assertId(request.params.deploymentId, "deploymentId")),
  );

  app.post<DeploymentParams>("/deployments/:deploymentId/cancel", async (request) =>
    deps.deployments.cancel(assertId(request.params.deploymentId, "deploymentId")),
  );

  // ----------------------------------------------------------- components --
  type ComponentParams = { Params: { componentId: string }; Querystring: { userId?: string } };

  /** Phase 9 hook: `{ vars: [{ key, value }] }` → the component's Render service. */
  app.put<ComponentParams>("/components/:componentId/env", async (request) => {
    const userId = assertId(request.query.userId ?? "", "userId");
    return deps.deployments.setEnv(userId, assertId(request.params.componentId, "componentId"), parseEnvVarsBody(request.body));
  });

  /** Phase 11 hook: `{ renderDeployId }` → that deploy goes live again. */
  app.post<ComponentParams>("/components/:componentId/rollback", async (request) => {
    const userId = assertId(request.query.userId ?? "", "userId");
    const { renderDeployId } = parseRollbackBody(request.body);
    return deps.deployments.rollback(userId, assertId(request.params.componentId, "componentId"), renderDeployId);
  });

  /** Deletes the component's Render service. Implemented; not called by the MVP. */
  app.delete<ComponentParams>("/components/:componentId", async (request) => {
    const userId = assertId(request.query.userId ?? "", "userId");
    return deps.deployments.destroyService(userId, assertId(request.params.componentId, "componentId"));
  });

  // ------------------------------------------------------------ log proxy --
  type ProxyParams = {
    Params: { componentId: string };
    Querystring: { userId?: string; type?: string | string[]; startTime?: string; limit?: string; direction?: string };
  };

  /**
   * Phase 12: one page of Render's GET /v1/logs for the component's service,
   * with Render's rate-limit headers passed on. Only backend/logs calls this;
   * it does the polling. The API key stays here.
   */
  app.get<ProxyParams>("/log-proxy/components/:componentId/logs", async (request, reply) => {
    const userId = assertId(request.query.userId ?? "", "userId");
    const componentId = assertId(request.params.componentId, "componentId");
    const types = Array.isArray(request.query.type) ? request.query.type : request.query.type ? [request.query.type] : ["app"];
    const abort = new AbortController();
    reply.raw.once("close", () => abort.abort());
    const { body, rateLimit } = await deps.logProxy!.logsPage(
      userId,
      componentId,
      {
        types,
        startTime: request.query.startTime ?? new Date(Date.now() - 15 * 60_000).toISOString(),
        limit: Number(request.query.limit ?? 100) || 100,
        direction: request.query.direction === "backward" ? "backward" : "forward",
      },
      abort.signal,
    );
    for (const [name, value] of Object.entries(rateLimit)) reply.header(name, value);
    reply.header("cache-control", "no-store");
    return body;
  });

  return app;
}
