/**
 * The wire contract with the main backend. The backend mirrors these in
 * backend/lib/providers/neon-service.types.ts; change both together.
 *
 * Unlike Vercel and Render there are no deploy events: provisioning is
 * synchronous, so nothing is posted back to the backend.
 */

export type { EnvVar } from "@orbitops/integration-common/contract";

/** A Neon organization the key can see. */
export interface NeonOrg {
  id: string;
  name: string;
}

/** POST /databases, from the main backend. */
export interface DatabaseRequest {
  userId: string;
  /** The main backend's Component.id of the database component. */
  componentId: string;
  /** The backend project's name (usually the repository's), for the Neon project name. */
  projectName: string;
  /** The component's name ("database"). */
  componentName: string;
}

export type DatabaseState = "provisioning" | "ready" | "failed";

/** What the main backend may see of a database. Never a password or a connection string. */
export interface DatabaseView {
  componentId: string;
  state: DatabaseState;
  neonProjectId: string;
  name: string;
  regionId: string;
  pgVersion: number;
  host: string | null;
  databaseName: string;
  roleName: string;
  consoleUrl: string;
  /** Set by POST /databases: true when this call created the Neon project. */
  created?: boolean;
  /** A note worth logging: the project was deleted on Neon and recreated empty. */
  warning?: string | null;
  lastError: string | null;
}

/**
 * GET /databases/:componentId/connection. The only response that carries a
 * secret. The backend holds it in memory for one deploy request.
 */
export interface ConnectionView {
  /** Through Neon's connection pooler: for the application. */
  pooledUri: string;
  /** Straight to the compute: for migrations (Prisma's directUrl). */
  directUri: string;
}
