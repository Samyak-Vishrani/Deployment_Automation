/**
 * Environment for the Render integration service, read once and validated so a
 * missing secret fails at startup with a list of what to set, rather than as a
 * 500 on the first deploy.
 */

import { baseUrl, positiveInt, requireEnv, requireSecretLength } from "@orbitops/integration-common/config-helpers";

export interface ServiceConfig {
  host: string;
  port: number;
  /** Expected in the x-internal-token header of every request from the main backend. */
  serviceToken: string;
  /** Where deploy events are delivered: `${mainApiUrl}/api/internal/provider-events`. */
  mainApiUrl: string;
  /** HMAC key for those callbacks. */
  callbackSecret: string;
  renderApiBase: string;
  deployConcurrency: number;
  pollIntervalMs: number;
  deployTimeoutMs: number;
  /** Phase 12: the token backend/logs sends to /log-proxy. Optional: unset turns the proxy off. */
  logsProxyToken: string | null;
}

export { MissingEnvError } from "@orbitops/integration-common/config-helpers";

const FOLDER = "render_integration";

/** LOGS_PROXY_TOKEN, checked: long enough, and never the internal token (each opens different doors). */
function logsProxyToken(env: NodeJS.ProcessEnv): string | null {
  const value = env.LOGS_PROXY_TOKEN?.trim();
  if (!value) return null;
  requireSecretLength(env, ["LOGS_PROXY_TOKEN"]);
  if (value === env.RENDER_SERVICE_TOKEN?.trim()) {
    throw new Error("LOGS_PROXY_TOKEN must differ from RENDER_SERVICE_TOKEN.");
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  requireEnv(env, ["DATABASE_URL", "RENDER_SERVICE_TOKEN", "RENDER_CALLBACK_SECRET"], FOLDER);
  requireSecretLength(env, ["RENDER_SERVICE_TOKEN", "RENDER_CALLBACK_SECRET"]);

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: positiveInt(env.PORT, 3003),
    serviceToken: env.RENDER_SERVICE_TOKEN!.trim(),
    mainApiUrl: baseUrl(env.MAIN_API_URL, "http://localhost:3001"),
    callbackSecret: env.RENDER_CALLBACK_SECRET!.trim(),
    renderApiBase: baseUrl(env.RENDER_API_BASE, "https://api.render.com/v1"),
    deployConcurrency: positiveInt(env.DEPLOY_CONCURRENCY, 8),
    pollIntervalMs: positiveInt(env.RENDER_POLL_INTERVAL_MS, 3000),
    deployTimeoutMs: positiveInt(env.RENDER_DEPLOY_TIMEOUT_MIN, 45) * 60 * 1000,
    logsProxyToken: logsProxyToken(env),
  };
}
