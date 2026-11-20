import { INTERNAL_TOKEN_HEADER, isValidInternalToken } from "@orbitops/integration-common/internal-auth";
import { ProviderError, ServiceError } from "@orbitops/integration-common/provider-error";
import Fastify, { type FastifyInstance } from "fastify";
import { assertId, parseKeyInput, parsePreferencesInput } from "./credentials/credential-input";
import type { CredentialsService } from "./credentials/credentials.service";
import { parseDatabaseRequest } from "./databases/database-input";
import type { DatabasesService } from "./databases/databases.service";
import { REGIONS, PG_VERSIONS } from "./neon/regions";

export interface AppDeps {
  serviceToken: string;
  credentials: Pick<CredentialsService, "get" | "save" | "setPreferences" | "remove">;
  databases: Pick<DatabasesService, "ensure" | "get" | "connection" | "destroy">;
  /** Liveness of the database, for /health. */
  checkDatabase?: () => Promise<boolean>;
  logger?: boolean;
}

/**
 * The internal HTTP API. Only the main backend talks to it: every route except
 * /health requires the shared x-internal-token (NEON_SERVICE_TOKEN), and the
 * main backend always passes the userId it authenticated, so this service
 * never sees a browser.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    // Request logs carry the method, URL and status only, never a body; the
    // tokens in headers are redacted all the same.
    logger: deps.logger ? { redact: ["req.headers.authorization", `req.headers["${INTERNAL_TOKEN_HEADER}"]`] } : false,
    bodyLimit: 64 * 1024,
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
    return reply
      .code(500)
      .send({ error: "internal_server_error", message: "The Neon integration hit an unexpected error." });
  });

  // --------------------------------------------------------------- health --
  app.get("/health", async (_request, reply) => {
    const database = deps.checkDatabase ? await deps.checkDatabase().catch(() => false) : true;
    return reply.code(database ? 200 : 503).send({ status: database ? "ok" : "degraded", database });
  });

  /** The choices Settings offers. */
  app.get("/options", async () => ({ regions: REGIONS, pgVersions: PG_VERSIONS }));

  // ---------------------------------------------------------- credentials --
  type UserParams = { Params: { userId: string } };

  app.get<UserParams>("/users/:userId/credential", async (request) =>
    deps.credentials.get(assertId(request.params.userId, "userId")),
  );

  app.put<UserParams>("/users/:userId/credential", async (request) => {
    const { apiKey } = parseKeyInput(request.body);
    return deps.credentials.save(assertId(request.params.userId, "userId"), apiKey);
  });

  /** `{ orgId?, regionId?, pgVersion? }`: the organization and the defaults for new databases. */
  app.patch<UserParams>("/users/:userId/credential", async (request) =>
    deps.credentials.setPreferences(assertId(request.params.userId, "userId"), parsePreferencesInput(request.body)),
  );

  app.delete<UserParams>("/users/:userId/credential", async (request) =>
    deps.credentials.remove(assertId(request.params.userId, "userId")),
  );

  // ------------------------------------------------------------ databases --
  type DatabaseParams = { Params: { componentId: string }; Querystring: { userId?: string } };

  /** Creates (or finds) the component's Neon project and waits until it is ready. Idempotent. */
  app.post("/databases", async (request) => deps.databases.ensure(parseDatabaseRequest(request.body)));

  app.get<DatabaseParams>("/databases/:componentId", async (request) =>
    deps.databases.get(assertId(request.query.userId, "userId"), assertId(request.params.componentId, "componentId")),
  );

  /**
   * The pooled and direct connection strings. The only route that returns a
   * secret: never cached, never logged, and the backend keeps it in memory for
   * one deploy request.
   */
  app.get<DatabaseParams>("/databases/:componentId/connection", async (request, reply) => {
    const view = await deps.databases.connection(
      assertId(request.query.userId, "userId"),
      assertId(request.params.componentId, "componentId"),
    );
    return reply.header("cache-control", "no-store").send(view);
  });

  /** Deletes the Neon project. Implemented; not called by the MVP. */
  app.delete<DatabaseParams>("/databases/:componentId", async (request) =>
    deps.databases.destroy(assertId(request.query.userId, "userId"), assertId(request.params.componentId, "componentId")),
  );

  return app;
}
