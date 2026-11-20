import type { EnvVar } from "../types";

/**
 * The env vars a backend is given for its Neon database:
 *
 * - DATABASE_URL: through Neon's pooler, for the application;
 * - DATABASE_URL_UNPOOLED: straight to the compute, for migrations (Prisma's
 *   `directUrl = env("DATABASE_URL_UNPOOLED")`), the same names Neon's own
 *   integrations use.
 *
 * Built here so the names live next to the URIs; the main backend sends the
 * pair to Render.
 */
export function systemEnv(connection: { pooledUri: string; directUri: string }): EnvVar[] {
  return [
    { key: "DATABASE_URL", value: connection.pooledUri },
    { key: "DATABASE_URL_UNPOOLED", value: connection.directUri },
  ];
}

export const SYSTEM_ENV_KEYS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const;

/** The host of a Postgres URI, for display: never the user or the password. */
export function safeHost(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

/** The project's page on the Neon console. */
export function consoleUrl(neonProjectId: string): string {
  return `https://console.neon.tech/app/projects/${encodeURIComponent(neonProjectId)}`;
}

/**
 * A Postgres URI Neon could plausibly have returned: postgres(ql)://, with a
 * user and a host. Anything else is refused rather than handed to a backend.
 */
export function isPostgresUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") && !!url.username && !!url.hostname;
  } catch {
    return false;
  }
}
