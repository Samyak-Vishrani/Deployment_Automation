import { getApiBaseUrl } from "./config";
import { ApiError } from "./error";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type RequestBody = Record<string, unknown> | unknown[] | string | number | boolean | null | undefined;

function buildUrl(path: string): string {
  const baseUrl = getApiBaseUrl();

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedPath = path.trim();
  const nextPath = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;

  return `${baseUrl}${nextPath}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const rawText = await response.text();
  if (!rawText) {
    return undefined as T;
  }

  try {
    return JSON.parse(rawText) as T;
  } catch {
    return rawText as T;
  }
}

async function readError(response: Response): Promise<{ message: string; code?: string; details?: unknown }> {
  const payload = await parseResponse<{
    message?: string;
    error?: string;
    code?: string;
    details?: unknown;
  }>(response).catch(() => undefined);

  if (payload) {
    return {
      message: payload.message ?? payload.error ?? response.statusText ?? "Request failed.",
      code: payload.code ?? payload.error,
      details: payload.details,
    };
  }

  return {
    message: response.statusText || "Request failed.",
  };
}

async function request<T>(method: HttpMethod, path: string, body?: RequestBody, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  const hasBody = body !== undefined && body !== null && method !== "GET" && method !== "DELETE";
  const payload = hasBody && typeof body !== "string" ? JSON.stringify(body) : body;

  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    const response = await fetch(buildUrl(path), {
      ...init,
      method,
      headers,
      body: hasBody ? (payload as BodyInit) : undefined,
    });

    if (!response.ok) {
      const errorPayload = await readError(response);
      throw new ApiError(response.status, errorPayload.message, {
        code: errorPayload.code,
        details: errorPayload.details,
      });
    }

    return await parseResponse<T>(response);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(0, error instanceof Error ? error.message : "Network request failed.", {
      code: "network_error",
    });
  }
}

export const api = {
  get<T>(path: string, init?: RequestInit) {
    return request<T>("GET", path, undefined, init);
  },
  post<T>(path: string, body?: RequestBody, init?: RequestInit) {
    return request<T>("POST", path, body, init);
  },
  put<T>(path: string, body?: RequestBody, init?: RequestInit) {
    return request<T>("PUT", path, body, init);
  },
  patch<T>(path: string, body?: RequestBody, init?: RequestInit) {
    return request<T>("PATCH", path, body, init);
  },
  delete<T>(path: string, init?: RequestInit) {
    return request<T>("DELETE", path, undefined, init);
  },
};
