/**
 * Small helpers each service's config.ts uses to read and validate its
 * environment once at startup, so a missing secret fails with a list of what
 * to set rather than as a 500 on the first request.
 */

export class MissingEnvError extends Error {
  constructor(
    readonly missing: string[],
    /** The service folder, for the hint: "render_integration". */
    folder: string,
  ) {
    super(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Copy ${folder}/.env.example to .env and fill them in.`,
    );
    this.name = "MissingEnvError";
  }
}

export const MIN_SECRET_LENGTH = 32;

export function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Throws MissingEnvError for unset keys. ENCRYPTION_KEY is required in
 * production only: in development each service falls back to its own
 * well-known key.
 */
export function requireEnv(env: NodeJS.ProcessEnv, keys: readonly string[], folder: string): void {
  const missing: string[] = keys.filter((key) => !env[key]?.trim());
  if (env.NODE_ENV === "production" && !env.ENCRYPTION_KEY?.trim()) {
    missing.push("ENCRYPTION_KEY");
  }
  if (missing.length > 0) {
    throw new MissingEnvError(missing, folder);
  }
}

/** Shared secrets must be long enough not to be guessed. */
export function requireSecretLength(env: NodeJS.ProcessEnv, keys: readonly string[], min = MIN_SECRET_LENGTH): void {
  for (const key of keys) {
    if ((env[key]?.trim().length ?? 0) < min) {
      throw new Error(
        `${key} must be at least ${min} characters ` +
          `(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))").`,
      );
    }
  }
}

/** A base URL without trailing slashes. */
export function baseUrl(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/, "");
}
