/**
 * Shapes shared across the service, and the wire contract with the main
 * backend. The main backend mirrors the request and event types in
 * backend/lib/providers/vercel-service.types.ts; change both together.
 */

/** A provider deployment's state, the same vocabulary for every provider. */
export type NormalisedStatus = "queued" | "deploying" | "building" | "live" | "failed" | "cancelled";

export const TERMINAL_STATES: ReadonlySet<NormalisedStatus> = new Set(["live", "failed", "cancelled"]);

export const isTerminal = (state: string): boolean => TERMINAL_STATES.has(state as NormalisedStatus);

export type SourceMode = "git" | "upload";

/** The parts of a main-backend Component this service needs. */
export interface ComponentSpec {
  id: string;
  name: string;
  /** Folder within the repository; "." is the root. */
  rootDir: string;
  framework: string | null;
  installCmd: string | null;
  buildCmd: string | null;
  outputDir: string | null;
  nodeVersion: string | null;
}

export interface RepoSpec {
  /** "owner/repo" */
  fullName: string;
  /** GitHub's numeric repository id; Vercel's Git source takes it. */
  repoId: number;
  branch: string;
}

/** POST /deployments, from the main backend. */
export interface DeployRequest {
  deploymentId: string;
  userId: string;
  component: ComponentSpec;
  repo: RepoSpec;
  commitSha: string;
  /**
   * A GitHub App installation token (about one hour of validity), used only to
   * download the source tarball for the upload fallback. Held in memory for the
   * run; never stored, never logged.
   */
  githubToken?: string;
}

/** What is persisted of a DeployRequest: everything except the GitHub token. */
export type StoredDeployInput = Omit<DeployRequest, "githubToken">;

export interface LogLine {
  /** Vercel's event id (or serial), for de-duplication across polls. */
  id: string;
  /** ms since epoch, as Vercel reports it. */
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
