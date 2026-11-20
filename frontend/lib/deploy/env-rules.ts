/**
 * Inline checks for the env editor (Phase 9), mirroring
 * backend/lib/env/env-rules.ts. The backend stays authoritative: these only
 * catch mistakes before a round trip. Messages name keys, never values.
 */

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SECRET_WORDS = /SECRET|TOKEN|KEY|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|DATABASE_URL|DSN|AUTH/;

/** Inlined into browser code by the framework, so public by construction. */
export const PUBLIC_PREFIXES = ["NEXT_PUBLIC_", "NUXT_PUBLIC_", "VITE_", "REACT_APP_", "PUBLIC_", "EXPO_PUBLIC_", "GATSBY_"];

const VERCEL_RESERVED = new Set([
  "AWS_SECRET_KEY",
  "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_LOG_GROUP_NAME",
  "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "NOW_REGION",
  "TZ",
  "LAMBDA_TASK_ROOT",
  "LAMBDA_RUNTIME_DIR",
]);

export const isPublicKey = (key: string) => PUBLIC_PREFIXES.some((p) => key.toUpperCase().startsWith(p));

/** The default for imported rows; the user can change it. */
export function looksSecret(key: string): boolean {
  const upper = key.toUpperCase();
  return !isPublicKey(upper) && SECRET_WORDS.test(upper);
}

/** Which providers a scope's vars reach. Shared: every backend (Render) and local Docker. */
export type EnvTarget = { kind: "shared" } | { kind: "frontend" | "backend"; provider: string };

export function reservedReason(key: string, provider: string): string | null {
  const upper = key.toUpperCase();
  if (provider === "vercel" && (VERCEL_RESERVED.has(upper) || upper.startsWith("VERCEL_"))) return `${key} is reserved by Vercel`;
  if (provider === "render" && (upper === "RENDER" || upper.startsWith("RENDER_"))) return `${key} is set by Render itself`;
  return null;
}

/** The first problem with one row, or null. */
export function rowProblem(key: string, isSecret: boolean, target: EnvTarget): string | null {
  if (!key) return "Enter a name.";
  if (!ENV_KEY.test(key) || key.length > 255) return "Letters, digits and _ only, not starting with a digit.";
  const providers = target.kind === "shared" ? ["render", "local_docker"] : [target.provider];
  for (const provider of providers) {
    const reason = reservedReason(key, provider);
    if (reason) return `${reason}.`;
  }
  if (target.kind === "frontend" && isSecret && isPublicKey(key)) {
    return "Its prefix puts it in browser code, so it can't be a secret.";
  }
  return null;
}
