import { ProviderError } from "@orbitops/integration-common/provider-error";

/** The header the integration services' /log-proxy routes check (LOGS_PROXY_TOKEN). */
export const LOGS_PROXY_HEADER = "x-logs-token";

export interface ProxyOptions {
  vercelUrl: string;
  renderUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface RenderLogsQuery {
  types: Array<"app" | "request">;
  startTime: string;
  limit?: number;
  /** "backward" = newest first (the backfill); "forward" for polling. */
  direction?: "forward" | "backward";
}

/**
 * Calls the integration services' read-only log-proxy routes. Those add the
 * user's Vercel token or Render key and talk to the provider; this service
 * never holds a provider credential. Errors come back as ProviderErrors
 * carrying the service's own code (not_deployed, render_key_invalid…).
 */
export class ProxyClient {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: ProxyOptions) {
    this.fetch = options.fetchImpl ?? fetch;
  }

  /** Vercel's runtime-log stream of the component's live deployment, piped through vercel_integration. */
  async vercelRuntime(userId: string, componentId: string, signal: AbortSignal): Promise<{ body: AsyncIterable<Uint8Array>; deploymentId: string | null }> {
    const url = new URL(`${this.options.vercelUrl}/log-proxy/components/${encodeURIComponent(componentId)}/runtime-logs`);
    url.searchParams.set("userId", userId);
    const response = await this.call("vercel", url, signal);
    if (!response.body) throw new ProviderError("Vercel returned an empty log stream.", 502, "vercel_unavailable", { retryable: true });
    return { body: response.body as unknown as AsyncIterable<Uint8Array>, deploymentId: response.headers.get("x-vercel-deployment-id") };
  }

  /** One page of Render's GET /v1/logs for the component's service, through render_integration. */
  async renderLogs(
    userId: string,
    componentId: string,
    query: RenderLogsQuery,
    signal: AbortSignal,
  ): Promise<{ page: unknown; remaining: number | null; resetMs: number | null }> {
    const url = new URL(`${this.options.renderUrl}/log-proxy/components/${encodeURIComponent(componentId)}/logs`);
    url.searchParams.set("userId", userId);
    for (const type of query.types) url.searchParams.append("type", type);
    url.searchParams.set("startTime", query.startTime);
    url.searchParams.set("limit", String(query.limit ?? 100));
    url.searchParams.set("direction", query.direction ?? "forward");
    const response = await this.call("render", url, signal);
    const header = (name: string) => {
      const value = response.headers.get(name);
      const n = value === null ? NaN : Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const reset = header("ratelimit-reset");
    return { page: await response.json(), remaining: header("ratelimit-remaining"), resetMs: reset === null ? null : reset * 1000 };
  }

  private async call(provider: "vercel" | "render", url: URL, signal: AbortSignal): Promise<Response> {
    const label = provider === "vercel" ? "Vercel" : "Render";
    let response: Response;
    try {
      response = await this.fetch(url, { headers: { [LOGS_PROXY_HEADER]: this.options.token, accept: "application/json" }, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderError(
        `The ${label} integration service is not running (${(error as Error).message}).`,
        503,
        `${provider}_service_unavailable`,
        { retryable: true },
      );
    }
    if (response.ok) return response;
    let body: { error?: string; message?: string } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Not JSON: the status is all we have.
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const error = new ProviderError(
      body.message ?? `The ${label} integration answered ${response.status}.`,
      response.status === 401 ? 503 : response.status,
      response.status === 401 ? `${provider}_proxy_unauthorized` : (body.error ?? `${provider}_error`),
      { retryable: response.status === 429 || response.status >= 500 },
    );
    throw Object.assign(error, { retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined });
  }
}
