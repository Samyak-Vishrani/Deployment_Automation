import { NetworkError, providerFetch, type ProviderFetchOptions, type ProviderResponse } from "../http/provider-fetch";
import { ProviderError } from "../http/provider-error";

/** Who a Vercel call is made as. `teamId` is appended to every request when set. */
export interface VercelContext {
  token: string;
  teamId: string | null;
  signal?: AbortSignal;
}

export interface VercelRequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body. */
  body?: unknown;
  /** Raw body (file uploads); `headers` should then carry its content type. */
  rawBody?: Buffer | Uint8Array | string;
  headers?: Record<string, string>;
  fetch?: ProviderFetchOptions;
}

/** Shape of Vercel's error responses: `{ error: { code, message, invalidToken? } }`. */
export interface VercelErrorBody {
  error?: {
    code?: string;
    message?: string;
    invalidToken?: boolean;
    missing?: string[];
    [key: string]: unknown;
  };
}

let apiBase = "https://api.vercel.com";

/** Set once from config at startup; tests point it at a fake. */
export function setVercelApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, "");
}

export function vercelUrl(path: string, query: VercelRequestOptions["query"], teamId: string | null): string {
  const url = new URL(`${apiBase}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  if (teamId) url.searchParams.set("teamId", teamId);
  return url.toString();
}

/**
 * One Vercel REST call. Never throws on a non-2xx: callers branch on status
 * (a 404 project means "recreate", a 409 name means "pick another"), then hand
 * anything unexpected to `vercelError`.
 */
export async function vercelRequest<T = unknown>(
  ctx: VercelContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: VercelRequestOptions = {},
): Promise<ProviderResponse<T>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.token}`,
    "user-agent": "orbitops-vercel-integration",
    ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    ...options.headers,
  };

  try {
    return await providerFetch<T>(
      vercelUrl(path, options.query, ctx.teamId),
      {
        method,
        headers,
        body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      } as RequestInit,
      { signal: ctx.signal, ...options.fetch },
    );
  } catch (error) {
    if (error instanceof NetworkError) {
      throw new ProviderError(`Could not reach Vercel (${error.message}).`, 502, "vercel_unavailable", {
        retryable: true,
      });
    }
    throw error;
  }
}

export function errorOf(body: unknown): NonNullable<VercelErrorBody["error"]> {
  const error = (body as VercelErrorBody | null | undefined)?.error;
  return error && typeof error === "object" ? error : {};
}

/**
 * Maps a failed Vercel response onto a user-safe ProviderError. `action` says
 * what we were doing ("creating the Vercel project") for the message.
 *
 * Vercel's own error messages are written for end users and carry no secrets,
 * so they are passed through; the token is never part of them.
 */
export function vercelError(response: ProviderResponse<unknown>, action: string): ProviderError {
  const { status } = response;
  const error = errorOf(response.body);
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const detail = message ? `: ${message}` : "";
  const base = { providerCode: code, providerStatus: status };

  if (status === 401 || (status === 403 && error.invalidToken)) {
    return new ProviderError(
      "Vercel rejected the saved token. Reconnect Vercel in Settings.",
      412,
      "vercel_token_invalid",
      { ...base, invalidToken: true },
    );
  }
  if (status === 403) {
    return new ProviderError(
      `This Vercel token is not allowed to do this while ${action}${detail || "."} ` +
        "Check the token's scope and the selected team in Settings.",
      403,
      "vercel_forbidden",
      base,
    );
  }
  if (status === 402 || /limit|quota|exceeded|payment/i.test(code ?? "")) {
    return new ProviderError(
      `Vercel's plan limit was reached while ${action}${detail || "."}`,
      429,
      "vercel_limit",
      base,
    );
  }
  if (status === 429) {
    return new ProviderError(
      "Vercel is rate-limiting requests; try again in a minute.",
      429,
      "vercel_rate_limited",
      { ...base, retryable: true },
    );
  }
  if (status >= 500) {
    return new ProviderError(
      `Vercel had an internal error while ${action} (HTTP ${status}). Try again shortly.`,
      502,
      "vercel_unavailable",
      { ...base, retryable: true },
    );
  }
  return new ProviderError(
    `Vercel returned an error while ${action} (HTTP ${status}${code ? `, ${code}` : ""})${detail || "."}`,
    400,
    "vercel_error",
    base,
  );
}

/** Throws the mapped error unless the response is 2xx. */
export function expectOk<T>(response: ProviderResponse<T>, action: string): T {
  if (response.status < 200 || response.status >= 300) {
    throw vercelError(response, action);
  }
  return response.body;
}
