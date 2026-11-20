/**
 * Environment for the logs service, read once and validated so a missing
 * secret fails at startup with a list of what to set.
 */

import { isAbsolute, resolve } from "node:path";
import { baseUrl, positiveInt, requireEnv, requireSecretLength } from "@orbitops/integration-common/config-helpers";

export { MissingEnvError } from "@orbitops/integration-common/config-helpers";

export interface LogsConfig {
  host: string;
  port: number;
  /** Expected in x-internal-token from the main backend. */
  serviceToken: string;
  /** Sent as x-logs-token to the integration services' /log-proxy routes. */
  proxyToken: string;
  vercelServiceUrl: string;
  renderServiceUrl: string;
  /** Build logs: <dataDir>/<projectId>/<deploymentId>.jsonl (+ .meta.json). */
  dataDir: string;
  /** Pre-Phase-12 logs, read only: <legacyDir>/<projectId>/<deploymentId>.log. */
  legacyDir: string;
  maxLogBytes: number;
  runtimeMaxMs: number;
  runtimeIdleMs: number;
  renderPollMs: number;
  maxStreamsPerUser: number;
}

const FOLDER = "logs";

const dir = (value: string | undefined, fallback: string) => {
  const path = value?.trim() || fallback;
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LogsConfig {
  requireEnv(env, ["LOGS_SERVICE_TOKEN", "LOGS_PROXY_TOKEN"], FOLDER);
  requireSecretLength(env, ["LOGS_SERVICE_TOKEN", "LOGS_PROXY_TOKEN"]);
  if (env.LOGS_SERVICE_TOKEN!.trim() === env.LOGS_PROXY_TOKEN!.trim()) {
    throw new Error("LOGS_PROXY_TOKEN must differ from LOGS_SERVICE_TOKEN: each opens different doors.");
  }

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: positiveInt(env.PORT, 3005),
    serviceToken: env.LOGS_SERVICE_TOKEN!.trim(),
    proxyToken: env.LOGS_PROXY_TOKEN!.trim(),
    vercelServiceUrl: baseUrl(env.VERCEL_SERVICE_URL, "http://127.0.0.1:3002"),
    renderServiceUrl: baseUrl(env.RENDER_SERVICE_URL, "http://127.0.0.1:3003"),
    dataDir: dir(env.DATA_DIR, "./data"),
    legacyDir: dir(env.LEGACY_LOG_DIR, "../data/logs"),
    maxLogBytes: positiveInt(env.MAX_LOG_BYTES, 20 * 1024 * 1024),
    runtimeMaxMs: positiveInt(env.RUNTIME_STREAM_MAX_MS, 60 * 60 * 1000),
    runtimeIdleMs: positiveInt(env.RUNTIME_IDLE_MS, 15 * 60 * 1000),
    // Render allows 30 log reads a minute: 3 s leaves room for paging.
    renderPollMs: positiveInt(env.RENDER_RUNTIME_POLL_MS, 3000),
    maxStreamsPerUser: positiveInt(env.MAX_STREAMS_PER_USER, 3),
  };
}
