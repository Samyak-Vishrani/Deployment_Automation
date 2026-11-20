/**
 * The wire contract with the neondb_integration service
 * (backend/neondb_integration/src/types.ts and its routes). Mirrored by hand
 * because the two are separate services that share no code; change both
 * together.
 */

import type { CredentialState } from "./vercel-service.types";

export interface NeonOrg {
  id: string;
  name: string;
}

export interface NeonCredentialView {
  provider: "neon";
  state: CredentialState;
  accountName: string | null;
  /** The organization new projects are created in; null = the key's default. */
  orgId: string | null;
  orgName: string | null;
  orgs: NeonOrg[];
  /** Defaults for new databases; Neon fixes both once a project exists. */
  regionId: string | null;
  pgVersion: number | null;
  /** True once a Neon project exists; the organization can no longer be changed. */
  scopeLocked: boolean;
  lastValidatedAt: string | null;
}

export interface NeonPreferences {
  orgId?: string | null;
  regionId?: string;
  pgVersion?: number;
}

export interface NeonDatabaseRequest {
  userId: string;
  componentId: string;
  projectName: string;
  componentName: string;
}

export type NeonDatabaseState = "provisioning" | "ready" | "failed";

/** Never a password or a connection string. */
export interface NeonDatabaseView {
  componentId: string;
  state: NeonDatabaseState;
  neonProjectId: string;
  name: string;
  regionId: string;
  pgVersion: number;
  host: string | null;
  databaseName: string;
  roleName: string;
  consoleUrl: string;
  /** Set by ensureDatabase: whether this call created the Neon project. */
  created?: boolean;
  /** Worth logging: the project was deleted on Neon and recreated empty, or replaced after a failed setup. */
  warning?: string | null;
  lastError: string | null;
}

/** The only secret-bearing answer. Held in memory for one deploy request; never logged or stored. */
export interface NeonConnection {
  pooledUri: string;
  directUri: string;
}
