/**
 * Environment for the Vercel integration service, read once and validated so a
 * missing secret fails at startup with a list of what to set, rather than as a
 * 500 on the first deploy.
 */

export interface ServiceConfig {
  host: string;
  port: number;
  /** Expected in the x-internal-token header of every request from the main backend. */
  internalServiceToken: string;
  /** Where deploy events are delivered: `${mainApiUrl}/api/internal/provider-events`. */
  mainApiUrl: string;
  /** HMAC key for those callbacks. */
  internalCallbackSecret: string;
  vercelApiBase: string;
  deployConcurrency: number;
  pollIntervalMs: number;
  deployTimeoutMs: number;
}

export class MissingEnvError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Copy vercel_integration/.env.example to .env and fill them in.",
    );
    this.name = "MissingEnvError";
  }
}

const MIN_SECRET_LENGTH = 32;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const required = ["DATABASE_URL", "INTERNAL_SERVICE_TOKEN", "INTERNAL_CALLBACK_SECRET"] as const;
  const missing: string[] = required.filter((key) => !env[key]?.trim());
  if (env.NODE_ENV === "production" && !env.ENCRYPTION_KEY?.trim()) {
    missing.push("ENCRYPTION_KEY");
  }
  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }

  for (const key of ["INTERNAL_SERVICE_TOKEN", "INTERNAL_CALLBACK_SECRET"] as const) {
    if (env[key]!.trim().length < MIN_SECRET_LENGTH) {
      throw new Error(`${key} must be at least ${MIN_SECRET_LENGTH} characters (use: openssl rand -hex 32).`);
    }
  }

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: positiveInt(env.PORT, 3002),
    internalServiceToken: env.INTERNAL_SERVICE_TOKEN!.trim(),
    mainApiUrl: (env.MAIN_API_URL?.trim() || "http://localhost:3001").replace(/\/+$/, ""),
    internalCallbackSecret: env.INTERNAL_CALLBACK_SECRET!.trim(),
    vercelApiBase: (env.VERCEL_API_BASE?.trim() || "https://api.vercel.com").replace(/\/+$/, ""),
    deployConcurrency: positiveInt(env.DEPLOY_CONCURRENCY, 8),
    pollIntervalMs: positiveInt(env.VERCEL_POLL_INTERVAL_MS, 3000),
    deployTimeoutMs: positiveInt(env.VERCEL_DEPLOY_TIMEOUT_MIN, 45) * 60 * 1000,
  };
}
