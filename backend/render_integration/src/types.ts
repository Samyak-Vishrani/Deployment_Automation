/**
 * Shapes shared across the service, and the wire contract with the main
 * backend. The backend mirrors the request and event types in
 * backend/lib/providers/render-service.types.ts; change both together.
 */

/** A provider deployment's state, the same vocabulary for every provider. */
export type NormalisedStatus = "queued" | "deploying" | "building" | "live" | "failed" | "cancelled";

export const TERMINAL_STATES: ReadonlySet<NormalisedStatus> = new Set(["live", "failed", "cancelled"]);

export const isTerminal = (state: string): boolean => TERMINAL_STATES.has(state as NormalisedStatus);

/** Render always builds from the Git repository itself. */
export type SourceMode = "git";

/** The parts of a main-backend Component this service needs. */
export interface ComponentSpec {
  id: string;
  name: string;
  /** Folder within the repository; "." is the root. */
  rootDir: string;
  framework: string | null;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  nodeVersion: string | null;
  /** Path Render (and our probe) check once the service is up, e.g. "/health". */
  healthCheckPath: string | null;
}

export interface RepoSpec {
  /** "owner/repo" */
  fullName: string;
  branch: string;
}

export interface EnvVar {
  key: string;
  value: string;
}

/** POST /deployments, from the main backend. */
export interface DeployRequest {
  deploymentId: string;
  userId: string;
  component: ComponentSpec;
  repo: RepoSpec;
  commitSha: string;
  /**
   * The project's env vars. Held in memory for the run only (deployments/env-vault):
   * never written to this service's database, never logged.
   */
  envVars?: EnvVar[];
}

/** What is persisted of a DeployRequest: everything except the env var values. */
export type StoredDeployInput = Omit<DeployRequest, "envVars"> & { envKeys: string[] };

export interface LogLine {
  /** Render's log id, for de-duplication across polls. */
  id: string;
  /** ms since epoch. */
  at: number;
  stream: "stdout" | "stderr" | "info";
  text: string;
}

/** Events delivered to the main backend, in order, batched with a sequence number. */
export type ProviderEvent =
  | { type: "status"; providerStatus: NormalisedStatus; errorMessage?: string }
  | { type: "resource"; componentId: string; providerResourceId: string; projectName: string }
  | {
      type: "deployment";
      providerDeploymentId: string;
      sourceMode: SourceMode;
      url: string | null;
      inspectorUrl: string | null;
    }
  | { type: "logs"; lines: Array<{ at: number; stream: LogLine["stream"]; text: string }> }
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
