import Fastify, { type FastifyInstance } from "fastify";
import { INTERNAL_TOKEN_HEADER, isValidInternalToken } from "@orbitops/integration-common/internal-auth";
import { ProviderError, ServiceError } from "@orbitops/integration-common/provider-error";
import { assertId, parseTeamInput, parseTokenInput } from "./credentials/credential-input";
import type { CredentialsService } from "./credentials/credentials.service";
import { parseDeployRequest, parseEnvVars } from "./deployments/deploy-input";
import type { DeploymentsService } from "./deployments/deployments.service";
import { LOGS_PROXY_HEADER, type VercelLogProxy } from "./log-proxy/log-proxy";

export interface AppDeps {
  internalServiceToken: string;
  credentials: Pick<CredentialsService, "get" | "save" | "setTeam" | "remove">;
  deployments: Pick<DeploymentsService, "start" | "get" | "listActive" | "cancel" | "setEnv" | "destroyProject">;
  /** Liveness of the database, for /health. */
  checkDatabase?: () => Promise<boolean>;
  /** Phase 12: read-only runtime-log access for backend/logs, behind its own token. */
  logProxy?: Pick<VercelLogProxy, "openRuntime">;
  /** LOGS_PROXY_TOKEN; accepted on /log-proxy routes only. Unset = those routes are off. */
  logsProxyToken?: string;
  logger?: boolean;
}

/**
 * The internal HTTP API. Only the main backend talks to it: every route except
 * /health requires the shared x-internal-token, and the main backend always
 * passes the userId it authenticated, so this service never sees a browser.
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
        return reply.code(503).send({ error: "log_proxy_disabled", message: "LOGS_PROXY_TOKEN is not set in vercel_integration/.env." });
      }
      if (!isValidInternalToken(deps.logsProxyToken, request.headers[LOGS_PROXY_HEADER])) {
        return reply.code(401).send({ error: "unauthorized", message: "Missing or wrong logs proxy token." });
      }
      return;
    }
    if (!isValidInternalToken(deps.internalServiceToken, request.headers[INTERNAL_TOKEN_HEADER])) {
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
    return reply.code(500).send({ error: "internal_server_error", message: "The Vercel integration hit an unexpected error." });
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
    const { token } = parseTokenInput(request.body);
    return deps.credentials.save(assertId(request.params.userId, "userId"), token);
  });

  app.patch<UserParams>("/users/:userId/credential", async (request) => {
    const { teamId } = parseTeamInput(request.body);
    return deps.credentials.setTeam(assertId(request.params.userId, "userId"), teamId);
  });

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
      throw new ServiceError('Only ?state=active is supported.', 400, "bad_request");
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

  /** Phase 9 hook: `{ vars: [{ key, value }] }` → the component's Vercel project. */
  app.put<ComponentParams>("/components/:componentId/env", async (request) => {
    const userId = assertId(request.query.userId ?? "", "userId");
    return deps.deployments.setEnv(userId, assertId(request.params.componentId, "componentId"), parseEnvVars(request.body));
  });

  /** Deletes the component's Vercel project. Implemented; not called by the MVP. */
  app.delete<ComponentParams>("/components/:componentId", async (request) => {
    const userId = assertId(request.query.userId ?? "", "userId");
    return deps.deployments.destroyProject(userId, assertId(request.params.componentId, "componentId"));
  });

  // ------------------------------------------------------------ log proxy --
  type ProxyParams = { Params: { componentId: string }; Querystring: { userId?: string } };

  /**
   * Phase 12: Vercel's runtime-log stream of the component's live deployment,
   * piped back unchanged (application/stream+json). Only backend/logs calls
   * this; the token stays here. Closing the request closes the upstream.
   */
  app.get<ProxyParams>("/log-proxy/components/:componentId/runtime-logs", async (request, reply) => {
    const userId = assertId(request.query.userId ?? "", "userId");
    const componentId = assertId(request.params.componentId, "componentId");
    const abort = new AbortController();
    reply.raw.once("close", () => abort.abort());
    let opened: Awaited<ReturnType<NonNullable<AppDeps["logProxy"]>["openRuntime"]>>;
    try {
      opened = await deps.logProxy!.openRuntime(userId, componentId, abort.signal);
    } catch (error) {
      // The logs service closed the request while Vercel had not answered yet (it only
      // answers once there is a log line): not an error, just a viewer who left.
      if (abort.signal.aborted) {
        reply.hijack();
        if (!reply.raw.writableEnded) reply.raw.end();
        return;
      }
      throw error;
    }
    const { body, vercelDeploymentId } = opened;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-vercel-deployment-id": vercelDeploymentId,
    });
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        if (abort.signal.aborted) break;
        reply.raw.write(chunk);
      }
    } catch {
      // The viewer left (abort) or Vercel cut the stream; either way it ends here.
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  return app;
}
