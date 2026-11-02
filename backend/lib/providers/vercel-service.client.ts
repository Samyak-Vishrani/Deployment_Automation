import type { HttpError } from "@/lib/api/http-error";
import {
  IntegrationServiceClient,
  type IntegrationServiceConfig,
  type IntegrationServiceInfo,
} from "./integration-service.client";
import type {
  VercelCredentialView,
  VercelDeployRequest,
  VercelDeploymentView,
} from "./vercel-service.types";

/**
 * Typed client for the vercel_integration service's internal API
 * (backend/vercel_integration, :3002). The HTTP plumbing is shared with the
 * other integration services in integration-service.client.ts.
 */

export const SERVICE_UNAVAILABLE = "vercel_service_unavailable";

export type VercelServiceConfig = IntegrationServiceConfig;

const INFO: IntegrationServiceInfo = {
  label: "Vercel",
  folder: "backend/vercel_integration",
  unavailableCode: SERVICE_UNAVAILABLE,
  tokenVar: "INTERNAL_SERVICE_TOKEN",
};

export function loadVercelServiceConfig(env: NodeJS.ProcessEnv = process.env): VercelServiceConfig {
  return {
    baseUrl: (env.VERCEL_SERVICE_URL?.trim() || "http://127.0.0.1:3002").replace(/\/+$/, ""),
    token: env.INTERNAL_SERVICE_TOKEN?.trim() ?? "",
  };
}

export function serviceUnavailable(detail?: string): HttpError {
  return new IntegrationServiceClient(INFO, loadVercelServiceConfig).unavailable(detail);
}

export class VercelServiceClient extends IntegrationServiceClient {
  constructor(loadConfig: () => VercelServiceConfig = loadVercelServiceConfig, timeoutMs = 15_000) {
    super(INFO, loadConfig, timeoutMs);
  }

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
}
