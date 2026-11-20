/**
 * Shapes shared across the service, and the wire contract with the main
 * backend. The backend mirrors the request and event types in
 * backend/lib/providers/render-service.types.ts; change both together.
 *
 * The provider-neutral half of the contract (states, log lines, events) lives
 * in backend/integration_common/src/contract.ts, shared by every integration.
 */

import type { EnvVar } from "@orbitops/integration-common/contract";

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
