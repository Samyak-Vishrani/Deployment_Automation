import {
  IntegrationServiceClient,
  type IntegrationServiceConfig,
  type IntegrationServiceInfo,
} from "./integration-service.client";
import type {
  NeonConnection,
  NeonCredentialView,
  NeonDatabaseRequest,
  NeonDatabaseView,
  NeonPreferences,
} from "./neon-service.types";

/**
 * Typed client for the neondb_integration service's internal API
 * (backend/neondb_integration, :3004). It has its own shared token
 * (NEON_SERVICE_TOKEN), separate from the Vercel and Render services'.
 *
 * Unlike those two, nothing comes back as events: provisioning is
 * synchronous, so `ensureDatabase` waits (up to about a minute) for Neon.
 */

export const NEON_SERVICE_UNAVAILABLE = "neon_service_unavailable";

const INFO: IntegrationServiceInfo = {
  label: "Neon",
  folder: "backend/neondb_integration",
  unavailableCode: NEON_SERVICE_UNAVAILABLE,
  tokenVar: "NEON_SERVICE_TOKEN",
};

/** The service waits up to NEON_PROVISION_TIMEOUT_MS (60 s) for Neon; this leaves it room to answer. */
const PROVISION_TIMEOUT_MS = 90_000;

export function loadNeonServiceConfig(env: NodeJS.ProcessEnv = process.env): IntegrationServiceConfig {
  return {
    baseUrl: (env.NEON_SERVICE_URL?.trim() || "http://127.0.0.1:3004").replace(/\/+$/, ""),
    token: env.NEON_SERVICE_TOKEN?.trim() ?? "",
  };
}

export class NeonServiceClient extends IntegrationServiceClient {
  constructor(
    loadConfig: () => IntegrationServiceConfig = loadNeonServiceConfig,
    timeoutMs = 15_000,
    private readonly provisionTimeoutMs = PROVISION_TIMEOUT_MS,
  ) {
    super(INFO, loadConfig, timeoutMs);
  }

  getCredential(userId: string): Promise<NeonCredentialView> {
    return this.call("GET", `/users/${encodeURIComponent(userId)}/credential`);
  }

  saveCredential(userId: string, apiKey: string): Promise<NeonCredentialView> {
    return this.call("PUT", `/users/${encodeURIComponent(userId)}/credential`, { apiKey });
  }

  setPreferences(userId: string, prefs: NeonPreferences): Promise<NeonCredentialView> {
    return this.call("PATCH", `/users/${encodeURIComponent(userId)}/credential`, prefs);
  }

  removeCredential(userId: string): Promise<{ deleted: boolean }> {
    return this.call("DELETE", `/users/${encodeURIComponent(userId)}/credential`);
  }

  /** Creates (or finds) the component's Neon project and waits until it is ready. Idempotent. */
  ensureDatabase(request: NeonDatabaseRequest): Promise<NeonDatabaseView> {
    return this.call("POST", "/databases", request, this.provisionTimeoutMs);
  }

  getDatabase(userId: string, componentId: string): Promise<NeonDatabaseView> {
    return this.call("GET", `/databases/${encodeURIComponent(componentId)}?userId=${encodeURIComponent(userId)}`);
  }

  /** The pooled and direct connection strings. Keep them in memory; never log or store them. */
  getConnection(userId: string, componentId: string): Promise<NeonConnection> {
    return this.call(
      "GET",
      `/databases/${encodeURIComponent(componentId)}/connection?userId=${encodeURIComponent(userId)}`,
    );
  }
}
