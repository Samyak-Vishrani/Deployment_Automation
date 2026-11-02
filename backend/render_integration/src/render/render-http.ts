import { redact } from "../common/redact";
import { NetworkError, providerFetch, type ProviderFetchOptions, type ProviderResponse } from "../http/provider-fetch";
import { ProviderError } from "../http/provider-error";

/** Who a Render call is made as. Render API keys are account-wide; the workspace is in each body/query. */
export interface RenderContext {
  apiKey: string;
  signal?: AbortSignal;
}

export interface RenderRequestOptions {
  query?: Record<string, string | number | boolean | undefined | null | Array<string | number>>;
  body?: unknown;
  fetch?: ProviderFetchOptions;
}

let apiBase = "https://api.render.com/v1";

/** Set once from config at startup; tests point it at a fake. */
export function setRenderApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, "");
}

export function renderUrl(path: string, query: RenderRequestOptions["query"]): string {
  const url = new URL(`${apiBase}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    // Render takes repeated keys for lists: ?type=build&type=app
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  return url.toString();
}

/**
 * One Render REST call. Never throws on a non-2xx: callers branch on status
 * (a 404 service means "recreate"), then hand anything unexpected to
 * `renderError`. Redirects are refused, so the key is never sent elsewhere.
 */
export async function renderRequest<T = unknown>(
  ctx: RenderContext,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  options: RenderRequestOptions = {},
): Promise<ProviderResponse<T>> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Render paths must be absolute API paths.");
  }
  try {
    return await providerFetch<T>(
      renderUrl(path, options.query),
      {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          accept: "application/json",
          "user-agent": "orbitops-render-integration",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      },
      { signal: ctx.signal, ...options.fetch },
    );
  } catch (error) {
    if (error instanceof NetworkError) {
      throw new ProviderError(`Could not reach Render (${error.message}).`, 502, "render_unavailable", {
        retryable: true,
      });
    }
    throw error;
  }
}

/** Render error bodies are `{ id?, message }`. The message is redacted before it is shown. */
export function messageOf(body: unknown, secrets: string[] = []): string {
  const message =
    typeof body === "string" ? body : ((body as { message?: unknown } | null | undefined)?.message ?? "");
  return typeof message === "string" ? redact(message.trim(), secrets).slice(0, 500) : "";
}

const REPO_ACCESS = /repo|repository|git|github|clone/i;

/**
 * Maps a failed Render response onto a user-safe ProviderError. `action` says
 * what we were doing ("creating the Render service") for the message.
 *
 * Render's error text can echo configuration back, so it is redacted (the key,
 * token-shaped strings) and cut short before it is shown.
 */
export function renderError(response: ProviderResponse<unknown>, action: string, secrets: string[] = []): ProviderError {
  const { status } = response;
  const message = messageOf(response.body, secrets);
  const detail = message ? `: ${message}` : ".";
  const base = { providerStatus: status };

  if (status === 401) {
    return new ProviderError(
      "Render rejected the saved API key. Reconnect Render in Settings.",
      412,
      "render_key_invalid",
      { ...base, invalidToken: true },
    );
  }
  if ((status === 400 || status === 404 || status === 422) && REPO_ACCESS.test(message)) {
    return new ProviderError(
      `Render cannot read the repository while ${action}${detail} ` +
        "Connect Render to GitHub (dashboard.render.com → Account Settings → Git) and give it access to this repo.",
      400,
      "render_repo_access",
      base,
    );
  }
  if (status === 402) {
    return new ProviderError(
      `Render needs billing details for this while ${action}${detail} Add a card on Render, or choose the Free plan in Settings.`,
      429,
      "render_billing",
      base,
    );
  }
  if (status === 403) {
    return new ProviderError(
      `Render denied access while ${action}${detail} Check the workspace selected in Settings.`,
      403,
      "render_forbidden",
      base,
    );
  }
  if (status === 409) {
    return new ProviderError(`Render reports a conflict while ${action}${detail}`, 409, "render_conflict", base);
  }
  if (status === 429) {
    return new ProviderError(
      "Render is rate-limiting requests; try again in a minute.",
      429,
      "render_rate_limited",
      { ...base, retryable: true },
    );
  }
  if (status >= 500) {
    return new ProviderError(
      `Render had an internal error while ${action} (HTTP ${status}). Try again shortly.`,
      502,
      "render_unavailable",
      { ...base, retryable: true },
    );
  }
  return new ProviderError(
    `Render returned an error while ${action} (HTTP ${status})${detail}`,
    400,
    "render_error",
    base,
  );
}

/** Throws the mapped error unless the response is 2xx. */
export function expectOk<T>(response: ProviderResponse<T>, action: string, secrets: string[] = []): T {
  if (response.status < 200 || response.status >= 300) {
    throw renderError(response, action, secrets);
  }
  return response.body;
}
