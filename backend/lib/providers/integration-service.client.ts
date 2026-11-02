import { HttpError } from "@/lib/api/http-error";

/**
 * The HTTP plumbing shared by the clients of the provider integration services
 * (backend/vercel_integration, backend/render_integration).
 *
 * Each service owns everything provider-specific; this backend only
 * authenticates the user, checks ownership, and forwards with the user's id
 * and the service's own shared token. Errors come back in the same
 * `{ error, message }` shape this API uses, so they are re-thrown as HttpError
 * and reach the browser unchanged.
 */

export interface IntegrationServiceConfig {
  baseUrl: string;
  token: string;
}

export interface IntegrationServiceInfo {
  /** "Vercel", "Render": used in messages. */
  label: string;
  /** Where the service lives, for the "start it" hint. */
  folder: string;
  /** Error code when the service cannot be reached, e.g. "render_service_unavailable". */
  unavailableCode: string;
  /** The env var holding the shared token, for configuration hints. */
  tokenVar: string;
}

/** True for "the integration service is down or misconfigured", whichever service it is. */
export function isServiceUnavailable(error: unknown): boolean {
  return error instanceof HttpError && error.code.endsWith("_service_unavailable");
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class IntegrationServiceClient {
  constructor(
    protected readonly info: IntegrationServiceInfo,
    private readonly loadConfig: () => IntegrationServiceConfig,
    private readonly timeoutMs = 15_000,
  ) {}

  unavailable(detail?: string): HttpError {
    return new HttpError(
      `The ${this.info.label} integration service is not running. Start it with \`npm run dev\` in ${this.info.folder}` +
        (detail ? ` (${detail})` : "") +
        ".",
      503,
      this.info.unavailableCode,
    );
  }

  protected async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const config = this.loadConfig();
    if (!config.token) {
      throw new HttpError(
        `${this.info.tokenVar} is not set in backend/.env, so the ${this.info.label} integration cannot be reached.`,
        503,
        this.info.unavailableCode,
      );
    }

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          "x-internal-token": config.token,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      const reason = (error as Error).name === "TimeoutError" ? "timed out" : "connection refused";
      throw this.unavailable(reason);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const error = parsed as { error?: string; message?: string } | undefined;
      if (response.status === 401) {
        throw new HttpError(
          `The ${this.info.label} integration rejected this backend's ${this.info.tokenVar}; ` +
            "it must be the same in both .env files.",
          503,
          this.info.unavailableCode,
        );
      }
      throw new HttpError(
        error?.message ?? `The ${this.info.label} integration answered HTTP ${response.status}.`,
        response.status >= 500 ? 502 : response.status,
        error?.error ?? `${this.info.label.toLowerCase()}_error`,
      );
    }
    return parsed as T;
  }
}
