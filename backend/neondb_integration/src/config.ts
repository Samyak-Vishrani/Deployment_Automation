/**
 * Environment for the Neon DB integration service, read once and validated so a
 * missing secret fails at startup with a list of what to set, rather than as a
 * 500 on the first request.
 */

import { baseUrl, positiveInt, requireEnv, requireSecretLength } from "@orbitops/integration-common/config-helpers";
import { DEFAULT_PG_VERSION, DEFAULT_REGION, isPgVersion, isRegionId } from "./neon/regions";

export { MissingEnvError } from "@orbitops/integration-common/config-helpers";

export interface ServiceConfig {
  host: string;
  port: number;
  /** Expected in the x-internal-token header of every request from the main backend. */
  serviceToken: string;
  neonApiBase: string;
  /** How long POST /databases waits for Neon's operations to finish. */
  provisionTimeoutMs: number;
  /** Region and Postgres version a newly connected key starts with. */
  defaultRegion: string;
  defaultPgVersion: number;
}

const FOLDER = "neondb_integration";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  requireEnv(env, ["DATABASE_URL", "NEON_SERVICE_TOKEN"], FOLDER);
  requireSecretLength(env, ["NEON_SERVICE_TOKEN"]);

  const region = env.DEFAULT_REGION?.trim() || DEFAULT_REGION;
  if (!isRegionId(region)) {
    throw new Error(`DEFAULT_REGION "${region}" is not a Neon region id (e.g. ${DEFAULT_REGION}).`);
  }
  const pgVersion = positiveInt(env.DEFAULT_PG_VERSION, DEFAULT_PG_VERSION);
  if (!isPgVersion(pgVersion)) {
    throw new Error(`DEFAULT_PG_VERSION ${pgVersion} is not a Postgres version Neon offers.`);
  }

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: positiveInt(env.PORT, 3004),
    serviceToken: env.NEON_SERVICE_TOKEN!.trim(),
    neonApiBase: baseUrl(env.NEON_API_BASE, "https://console.neon.tech/api/v2"),
    provisionTimeoutMs: positiveInt(env.NEON_PROVISION_TIMEOUT_MS, 60_000),
    defaultRegion: region,
    defaultPgVersion: pgVersion,
  };
}
