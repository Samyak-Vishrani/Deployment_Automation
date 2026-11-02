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
  | { type: "logs"; lines: Array<{ at: number; stream: "stdout" | "stderr" | "info"; text: string }> }
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
