import Fastify, { type FastifyInstance } from "fastify";
import { INTERNAL_TOKEN_HEADER, isValidInternalToken } from "./auth/internal-auth";
import { ProviderError, ServiceError } from "./http/provider-error";
import { assertId, parseTeamInput, parseTokenInput } from "./credentials/credential-input";
import type { CredentialsService } from "./credentials/credentials.service";
import { parseDeployRequest, parseEnvVars } from "./deployments/deploy-input";
import type { DeploymentsService } from "./deployments/deployments.service";

export interface AppDeps {
  internalServiceToken: string;
  credentials: Pick<CredentialsService, "get" | "save" | "setTeam" | "remove">;
  deployments: Pick<DeploymentsService, "start" | "get" | "listActive" | "cancel" | "setEnv" | "destroyProject">;
  /** Liveness of the database, for /health. */
  checkDatabase?: () => Promise<boolean>;
  logger?: boolean;
}

/**
 * The internal HTTP API. Only the main backend talks to it: every route except
 * /health requires the shared x-internal-token, and the main backend always
 * passes the userId it authenticated, so this service never sees a browser.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ? { redact: ["req.headers.authorization", `req.headers["${INTERNAL_TOKEN_HEADER}"]`] } : false,
    bodyLimit: 1024 * 1024,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
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

  return app;
}
