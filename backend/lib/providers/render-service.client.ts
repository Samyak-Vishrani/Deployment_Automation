import {
  IntegrationServiceClient,
  type IntegrationServiceConfig,
  type IntegrationServiceInfo,
} from "./integration-service.client";
import type {
  RenderCredentialView,
  RenderDeployRequest,
  RenderDeploymentView,
  RenderPreferences,
} from "./render-service.types";

/**
 * Typed client for the render_integration service's internal API
 * (backend/render_integration, :3003). It has its own shared token
 * (RENDER_SERVICE_TOKEN), separate from the Vercel service's.
 */

export const RENDER_SERVICE_UNAVAILABLE = "render_service_unavailable";

const INFO: IntegrationServiceInfo = {
  label: "Render",
  folder: "backend/render_integration",
  unavailableCode: RENDER_SERVICE_UNAVAILABLE,
  tokenVar: "RENDER_SERVICE_TOKEN",
};

export function loadRenderServiceConfig(env: NodeJS.ProcessEnv = process.env): IntegrationServiceConfig {
  return {
    baseUrl: (env.RENDER_SERVICE_URL?.trim() || "http://127.0.0.1:3003").replace(/\/+$/, ""),
    token: env.RENDER_SERVICE_TOKEN?.trim() ?? "",
  };
}

export class RenderServiceClient extends IntegrationServiceClient {
  constructor(loadConfig: () => IntegrationServiceConfig = loadRenderServiceConfig, timeoutMs = 15_000) {
    super(INFO, loadConfig, timeoutMs);
  }

  getCredential(userId: string): Promise<RenderCredentialView> {
    return this.call("GET", `/users/${encodeURIComponent(userId)}/credential`);
  }

  saveCredential(userId: string, apiKey: string): Promise<RenderCredentialView> {
    return this.call("PUT", `/users/${encodeURIComponent(userId)}/credential`, { apiKey });
  }

  setPreferences(userId: string, prefs: RenderPreferences): Promise<RenderCredentialView> {
    return this.call("PATCH", `/users/${encodeURIComponent(userId)}/credential`, prefs);
  }

  removeCredential(userId: string): Promise<{ deleted: boolean }> {
    return this.call("DELETE", `/users/${encodeURIComponent(userId)}/credential`);
  }

  startDeployment(request: RenderDeployRequest): Promise<RenderDeploymentView> {
    return this.call("POST", "/deployments", request);
  }

  getDeployment(deploymentId: string): Promise<RenderDeploymentView> {
    return this.call("GET", `/deployments/${encodeURIComponent(deploymentId)}`);
  }

  cancelDeployment(deploymentId: string): Promise<RenderDeploymentView> {
    return this.call("POST", `/deployments/${encodeURIComponent(deploymentId)}/cancel`);
  }

  listActive(): Promise<RenderDeploymentView[]> {
    return this.call("GET", "/deployments?state=active");
  }
}
