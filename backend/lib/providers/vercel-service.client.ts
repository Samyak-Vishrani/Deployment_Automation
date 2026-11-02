import { HttpError } from "@/lib/api/http-error";
import type {
  VercelCredentialView,
  VercelDeployRequest,
  VercelDeploymentView,
} from "./vercel-service.types";

/**
 * Typed client for the vercel_integration service's internal API.
 *
 * Everything Vercel-specific lives in that service; this backend only
 * authenticates the user, checks ownership, and forwards with the user's id.
 * Errors come back in the same `{ error, message }` shape this API uses, so
 * they are re-thrown as HttpError and reach the browser unchanged.
 */

export const SERVICE_UNAVAILABLE = "vercel_service_unavailable";

export interface VercelServiceConfig {
  baseUrl: string;
  token: string;
}

export function loadVercelServiceConfig(env: NodeJS.ProcessEnv = process.env): VercelServiceConfig {
  return {
    baseUrl: (env.VERCEL_SERVICE_URL?.trim() || "http://127.0.0.1:3002").replace(/\/+$/, ""),
    token: env.INTERNAL_SERVICE_TOKEN?.trim() ?? "",
  };
}

export function serviceUnavailable(detail?: string): HttpError {
  return new HttpError(
    "The Vercel integration service is not running. Start it with `npm run dev` in backend/vercel_integration" +
      (detail ? ` (${detail})` : "") +
      ".",
    503,
    SERVICE_UNAVAILABLE,
  );
}

export class VercelServiceClient {
  constructor(
    private readonly loadConfig: () => VercelServiceConfig = loadVercelServiceConfig,
    private readonly timeoutMs = 15_000,
  ) {}

  getCredential(userId: string): Promise<VercelCredentialView> {
    return this.call("GET", `/users/${encodeURIComponent(userId)}/credential`);
  }

  saveCredential(userId: string, token: string): Promise<VercelCredentialView> {
    return this.call("PUT", `/users/${encodeURIComponent(userId)}/credential`, { token });
  }

  setTeam(userId: string, teamId: string | null): Promise<VercelCredentialView> {
    return this.call("PATCH", `/users/${encodeURIComponent(userId)}/credential`, { teamId });
  }

  removeCredential(userId: string): Promise<{ deleted: boolean }> {
    return this.call("DELETE", `/users/${encodeURIComponent(userId)}/credential`);
  }

  startDeployment(request: VercelDeployRequest): Promise<VercelDeploymentView> {
    return this.call("POST", "/deployments", request);
  }

  getDeployment(deploymentId: string): Promise<VercelDeploymentView> {
    return this.call("GET", `/deployments/${encodeURIComponent(deploymentId)}`);
  }

  cancelDeployment(deploymentId: string): Promise<VercelDeploymentView> {
    return this.call("POST", `/deployments/${encodeURIComponent(deploymentId)}/cancel`);
  }

  listActive(): Promise<VercelDeploymentView[]> {
    return this.call("GET", "/deployments?state=active");
  }

  private async call<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const config = this.loadConfig();
    if (!config.token) {
      throw new HttpError(
        "INTERNAL_SERVICE_TOKEN is not set in backend/.env, so the Vercel integration cannot be reached.",
        503,
        SERVICE_UNAVAILABLE,
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
      throw serviceUnavailable(reason);
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
          "The Vercel integration rejected this backend's INTERNAL_SERVICE_TOKEN; it must be the same in both .env files.",
          503,
          SERVICE_UNAVAILABLE,
        );
      }
      throw new HttpError(
        error?.message ?? `The Vercel integration answered HTTP ${response.status}.`,
        response.status >= 500 ? 502 : response.status,
        error?.error ?? "vercel_error",
      );
    }
    return parsed as T;
  }
}
