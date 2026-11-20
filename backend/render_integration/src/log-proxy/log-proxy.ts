import { ProviderError } from "@orbitops/integration-common/provider-error";
import type { CredentialsService } from "../credentials/credentials.service";
import type { Db } from "../db";
import { renderError, renderRequest } from "../render/render-http";

/** The header backend/logs sends: LOGS_PROXY_TOKEN, valid on /log-proxy routes only. */
export const LOGS_PROXY_HEADER = "x-logs-token";

const TYPES = new Set(["app", "request"]);

export interface LogsPageQuery {
  types: string[];
  startTime: string;
  limit: number;
  /** "backward" = newest first (a backfill of the latest lines); "forward" (default) for polling. */
  direction?: "forward" | "backward";
}

/**
 * Read-only access to a component's Render logs for backend/logs (Phase 12).
 *
 * One `GET /v1/logs` page per call, for the component's own service: the
 * resource, owner and direction are fixed here from stored ids, never taken
 * from the caller. The polling loop, de-duplication and parsing all live in
 * backend/logs; the API key never leaves this service.
 */
export class RenderLogProxy {
  constructor(
    private readonly db: Db,
    private readonly credentials: Pick<CredentialsService, "getKey" | "markInvalid">,
  ) {}

  async logsPage(
    userId: string,
    componentId: string,
    query: LogsPageQuery,
    signal: AbortSignal,
  ): Promise<{ body: unknown; rateLimit: Record<string, string> }> {
    const types = query.types.filter((t) => TYPES.has(t));
    if (types.length === 0) throw new ProviderError("type must be app and/or request.", 400, "bad_request");
    if (Number.isNaN(Date.parse(query.startTime))) throw new ProviderError("startTime must be an ISO date-time.", 400, "bad_request");

    const service = await this.db.renderService.findUnique({ where: { componentId } });
    if (!service || service.userId !== userId) {
      throw new ProviderError("This component has no Render service yet. Deploy it first.", 404, "not_deployed");
    }
    const scope = await this.credentials.getKey(userId);
    const response = await renderRequest(
      { apiKey: scope.apiKey, signal },
      "GET",
      "/logs",
      {
        query: {
          ownerId: service.ownerId,
          resource: [service.renderServiceId],
          type: types,
          direction: query.direction === "backward" ? "backward" : "forward",
          startTime: new Date(query.startTime).toISOString(),
          limit: Math.min(Math.max(1, query.limit), 100),
        },
        // One attempt: the logs service paces its own polling and backs off on 429.
        fetch: { attempts: 1 },
      },
    );

    const rateLimit: Record<string, string> = {};
    for (const name of ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) rateLimit[name] = value;
    }
    if (response.status === 200) return { body: response.body, rateLimit };
    if (response.status === 401) {
      await this.credentials.markInvalid(userId);
      throw new ProviderError("Render rejected the saved API key. Reconnect Render in Settings.", 412, "render_key_invalid", { invalidToken: true });
    }
    if (response.status === 429) {
      throw new ProviderError("Render rate-limited the log reads.", 429, "render_rate_limited", { retryable: true });
    }
    throw renderError(response, "reading the logs", [scope.apiKey]);
  }
}
