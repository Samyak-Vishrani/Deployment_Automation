/**
 * The wire contract with the render_integration service
 * (backend/render_integration/src/types.ts and its routes). Mirrored by hand
 * because the two are separate services that share no code; change both
 * together.
 */

import type { CredentialState, ProviderStatus } from "./vercel-service.types";

export interface RenderOwner {
  id: string;
  name: string;
  type: string;
}

export interface RenderCredentialView {
  provider: "render";
  state: CredentialState;
  accountName: string | null;
  /** The Render workspace new services are created in. */
  ownerId: string | null;
  ownerName: string | null;
  owners: RenderOwner[];
  /** Defaults for new services; Render fixes both once a service exists. */
  region: string | null;
  plan: string | null;
  /** True once a Render service exists; the workspace can no longer be changed. */
  scopeLocked: boolean;
  lastValidatedAt: string | null;
}

export interface RenderPreferences {
  ownerId?: string;
  region?: string;
  plan?: string;
}

export interface RenderDeployRequest {
  deploymentId: string;
  userId: string;
  component: {
    id: string;
    name: string;
    rootDir: string;
    framework: string | null;
    installCmd: string | null;
    buildCmd: string | null;
    startCmd: string | null;
    nodeVersion: string | null;
    healthCheckPath: string | null;
  };
  repo: { fullName: string; branch: string };
  commitSha: string;
  /** The project's env vars. The service holds them in memory only; never stored there, never logged. */
  envVars: Array<{ key: string; value: string }>;
}

export interface RenderDeploymentView {
  deploymentId: string;
  componentId: string;
  state: ProviderStatus;
  renderDeployId: string | null;
  url: string | null;
  dashboardUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}
