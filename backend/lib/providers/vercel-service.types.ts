/**
 * The wire contract with the vercel_integration service
 * (backend/vercel_integration/src/types.ts and its routes). Mirrored by hand
 * because the two are separate services that share no code; change both
 * together.
 */

export type ProviderStatus = "queued" | "deploying" | "building" | "live" | "failed" | "cancelled";

export type CredentialState = "connected" | "invalid" | "missing";

export interface VercelCredentialView {
  provider: "vercel";
  state: CredentialState;
  accountName: string | null;
  teamId: string | null;
  teamSlug: string | null;
  teams: Array<{ id: string; slug: string; name: string }>;
  /** True once a Vercel project exists; the team can no longer be changed. */
  scopeLocked: boolean;
  lastValidatedAt: string | null;
}

export interface VercelDeployRequest {
  deploymentId: string;
  userId: string;
  component: {
    id: string;
    name: string;
    rootDir: string;
    framework: string | null;
    installCmd: string | null;
    buildCmd: string | null;
    outputDir: string | null;
    nodeVersion: string | null;
  };
  repo: { fullName: string; repoId: number; branch: string };
  commitSha: string;
  /** Installation token for the upload fallback's source download. Never stored by the service. */
  githubToken?: string;
  /**
   * Public, non-secret env vars set on the Vercel project before it builds:
   * the backend's URL (Phase 8). Absent = leave the project's env alone;
   * [] = remove the ones set before.
   */
  publicEnvVars?: Array<{ key: string; value: string }>;
  /**
   * The frontend's own env vars (Phase 9). Never stored by the service: held
   * in memory for the run, set on the Vercel project before the build, as
   * "sensitive" (secret) or "encrypted". [] = remove the ones set before.
   */
  envVars?: Array<{ key: string; value: string; secret: boolean }>;
}

export interface VercelDeploymentView {
  deploymentId: string;
  componentId: string;
  state: ProviderStatus;
  vercelDeploymentId: string | null;
  sourceMode: string | null;
  url: string | null;
  inspectorUrl: string | null;
  productionUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type ProviderEvent =
  | { type: "status"; providerStatus: ProviderStatus; errorMessage?: string }
  | { type: "resource"; componentId: string; providerResourceId: string; projectName: string }
  | {
      type: "deployment";
      providerDeploymentId: string;
      sourceMode: "git" | "upload";
      url: string | null;
      inspectorUrl: string | null;
    }
  | {
      type: "logs";
      lines: Array<{
        at: number;
        stream: "stdout" | "stderr" | "info";
        text: string;
        /** Phase 12: build vs runtime output, and who wrote the line (the integration service, or the provider). */
        phase?: "build" | "deploy" | "runtime";
        origin?: "orbitops" | "provider";
      }>;
    }
  | {
      type: "terminal";
      status: "live" | "failed" | "cancelled";
      productionUrl?: string | null;
      errorMessage?: string | null;
    };

export interface EventBatch {
  deploymentId: string;
  seq: number;
  events: ProviderEvent[];
}
