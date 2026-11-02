/**
 * fetch() with the resilience every provider API call needs: a per-request
 * timeout, retries with exponential backoff and jitter on 429 / 5xx / network
 * failures, and respect for the provider's own Retry-After and rate-limit
 * reset headers.
 *
 * Nothing here logs a header or a body: the Authorization header carries the
 * user's provider token.
 */

export interface ProviderFetchOptions {
  /** Attempts in total, including the first. */
  attempts?: number;
  timeoutMs?: number;
  /** Aborts the request and any pending retry wait. */
  signal?: AbortSignal;
  /** Base delay for backoff; doubled each attempt, plus jitter. */
  baseDelayMs?: number;
  /** Longest wait between attempts, whatever the provider asks for. */
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Retry only idempotent requests on a network error (a POST may have landed). */
  retryOnNetworkError?: boolean;
}

export interface ProviderResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

/** The request never produced a response: DNS, refused connection, timeout. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * How long the provider asked us to wait, in ms, or null if it did not say.
 * Retry-After is seconds (or an HTTP date); X-RateLimit-Reset is epoch seconds.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) return Math.max(0, epochSeconds * 1000 - now);
  }
  return null;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function providerFetch<T = unknown>(
  url: string,
  init: RequestInit,
  options: ProviderFetchOptions = {},
): Promise<ProviderResponse<T>> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? abortableSleep;
  const method = (init.method ?? "GET").toUpperCase();
  const retryNetwork = options.retryOnNetworkError ?? (method === "GET" || method === "DELETE");

  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? error;
      }
      const reason = timeout.aborted ? `timed out after ${timeoutMs} ms` : (error as Error).message;
      if (attempt < attempts && retryNetwork) {
        await sleep(backoff(attempt, baseDelay, maxDelay), options.signal);
        continue;
      }
      throw new NetworkError(reason);
    }

    if (RETRY_STATUSES.has(response.status) && attempt < attempts) {
      // Drain the body so the connection can be reused.
      await response.arrayBuffer().catch(() => undefined);
      const asked = retryAfterMs(response.headers);
      const wait = Math.min(maxDelay, asked ?? backoff(attempt, baseDelay, maxDelay));
      await sleep(wait, options.signal);
      continue;
    }

    return { status: response.status, headers: response.headers, body: (await parseBody(response)) as T };
  }
}

function backoff(attempt: number, base: number, max: number): number {
  const exponential = base * 2 ** (attempt - 1);
  const jitter = Math.random() * base;
  return Math.min(max, exponential + jitter);
}
