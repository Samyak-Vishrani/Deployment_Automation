/**
 * Shapes shared across the service, and the wire contract with the main
 * backend. The main backend mirrors the request and event types in
 * backend/lib/providers/vercel-service.types.ts; change both together.
 *
 * The provider-neutral half of the contract (states, log lines, events) lives
 * in backend/integration_common/src/contract.ts, shared by every integration.
 */

export {
  isTerminal,
  TERMINAL_STATES,
  type EnvVar,
  type EventBatch,
  type LogLine,
  type NormalisedStatus,
  type ProviderEvent,
  type SourceMode,
} from "@orbitops/integration-common/contract";

import type { EnvVar } from "@orbitops/integration-common/contract";

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
  /**
   * Public, non-secret env vars to set on the Vercel project before it builds:
   * today only the backend's URL (NEXT_PUBLIC_API_URL and the like, Phase 8).
   * Stored with the request, so a resumed run still has them. Absent = leave
   * the project's env vars alone; [] = remove the ones set before.
   */
  publicEnvVars?: EnvVar[];
  /**
   * The frontend's own env vars (Phase 9), set on the Vercel project before it
   * builds: secrets as "sensitive", the rest as "encrypted". Held in memory for
   * the run (an EnvVault), NEVER stored or logged. Absent = leave the project's
   * user vars alone; [] = remove the ones set before.
   */
  envVars?: UserEnvVar[];
}

/** One of the user's env vars, as the main backend sends it. */
export interface UserEnvVar {
  key: string;
  value: string;
  secret: boolean;
}

/**
 * What is persisted of a DeployRequest: everything except the GitHub token and
 * the env var values. `envKeys` records which user vars were sent, so a run
 * that lost them (restart, expiry) knows it cannot go on.
 */
export type StoredDeployInput = Omit<DeployRequest, "githubToken" | "envVars"> & { envKeys?: string[] };
