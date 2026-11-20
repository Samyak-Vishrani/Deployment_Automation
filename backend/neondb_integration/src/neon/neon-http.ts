import { ProviderError } from "@orbitops/integration-common/provider-error";
import {
  NetworkError,
  providerFetch,
  type ProviderFetchOptions,
  type ProviderResponse,
} from "@orbitops/integration-common/provider-fetch";
import { redact } from "@orbitops/integration-common/redact";

/** Who a Neon call is made as. */
export interface NeonContext {
  apiKey: string;
  signal?: AbortSignal;
}

export interface NeonRequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  fetch?: ProviderFetchOptions;
}

let apiBase = "https://console.neon.tech/api/v2";

/** Set once from config at startup; tests point it at a fake. */
export function setNeonApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, "");
}

export function neonUrl(path: string, query: NeonRequestOptions["query"]): string {
  const url = new URL(`${apiBase}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * One Neon REST call. Never throws on a non-2xx: callers branch on status (a
 * 404 project means "it was deleted on Neon"), then hand anything unexpected
 * to `neonError`. Redirects are refused, so the key is never sent elsewhere.
 */
export async function neonRequest<T = unknown>(
  ctx: NeonContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: NeonRequestOptions = {},
): Promise<ProviderResponse<T>> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Neon paths must be absolute API paths.");
  }
  try {
    return await providerFetch<T>(
      neonUrl(path, options.query),
      {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          accept: "application/json",
          "user-agent": "orbitops-neondb-integration",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      },
      { signal: ctx.signal, ...options.fetch },
    );
  } catch (error) {
    if (error instanceof NetworkError) {
      throw new ProviderError(`Could not reach Neon (${error.message}).`, 502, "neon_unavailable", {
        retryable: true,
      });
    }
    throw error;
  }
}

/** Neon error bodies are `{ code?, message }`. The message is redacted and cut short before it is shown. */
export function messageOf(body: unknown, secrets: string[] = []): string {
  const message =
    typeof body === "string" ? body : ((body as { message?: unknown } | null | undefined)?.message ?? "");
  return typeof message === "string" ? redactUris(redact(message.trim(), secrets)).slice(0, 500) : "";
}

export function codeOf(body: unknown): string | undefined {
  const code = (body as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Belt and braces: a connection string must never reach a message, whatever Neon echoes. */
function redactUris(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://***REDACTED***");
}

// Matched loosely until step 0's spike records Neon's exact wording.
const PROJECT_LIMIT = /limit|quota|exceed/i;
const ORG_REQUIRED = /org(?:anization)?[_ ]?id|organization/i;

/**
 * Maps a failed Neon response onto a user-safe ProviderError. `action` says
 * what we were doing ("creating the Neon project") for the message.
 */
export function neonError(response: ProviderResponse<unknown>, action: string, secrets: string[] = []): ProviderError {
  const { status } = response;
  const message = messageOf(response.body, secrets);
  const providerCode = codeOf(response.body);
  const detail = message ? `: ${message}` : ".";
  const base = { providerStatus: status, providerCode };

  if (status === 401) {
    return new ProviderError(
      "Neon rejected the saved API key. Reconnect Neon in Settings.",
      412,
      "neon_key_invalid",
      { ...base, invalidToken: true },
    );
  }
  if ((status === 400 || status === 422) && ORG_REQUIRED.test(message) && !PROJECT_LIMIT.test(message)) {
    return new ProviderError(
      `Neon needs an organization while ${action}${detail} Choose one in Settings → Integrations → Neon.`,
      412,
      "neon_org_required",
      base,
    );
  }
  if ((status === 402 || status === 403 || status === 409 || status === 422) && PROJECT_LIMIT.test(message)) {
    return new ProviderError(
      `Neon's plan limit is reached while ${action}${detail} Delete a project on Neon or upgrade the plan.`,
      409,
      "neon_project_limit",
      base,
    );
  }
  if (status === 403) {
    return new ProviderError(
      `Neon denied access while ${action}${detail} The key may not be allowed to use this organization.`,
      403,
      "neon_forbidden",
      base,
    );
  }
  if (status === 423) {
    return new ProviderError(
      `Neon is still busy with this project while ${action}; try again shortly.`,
      409,
      "neon_locked",
      { ...base, retryable: true },
    );
  }
  if (status === 429) {
    return new ProviderError("Neon is rate-limiting requests; try again in a minute.", 429, "neon_rate_limited", {
      ...base,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ProviderError(
      `Neon had an internal error while ${action} (HTTP ${status}). Try again shortly.`,
      502,
      "neon_unavailable",
      { ...base, retryable: true },
    );
  }
  return new ProviderError(`Neon returned an error while ${action} (HTTP ${status})${detail}`, 400, "neon_error", base);
}

/** Throws the mapped error unless the response is 2xx. */
export function expectOk<T>(response: ProviderResponse<T>, action: string, secrets: string[] = []): T {
  if (response.status < 200 || response.status >= 300) {
    throw neonError(response, action, secrets);
  }
  return response.body;
}
