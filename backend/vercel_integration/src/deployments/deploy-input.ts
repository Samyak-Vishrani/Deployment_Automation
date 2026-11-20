import { badRequest } from "@orbitops/integration-common/provider-error";
import type { DeployRequest, UserEnvVar } from "../types";
import type { EnvVarInput } from "../vercel/vercel.provider";

/**
 * Validates what the main backend sends. It is a trusted caller (it holds the
 * internal token), but a contract drift between two services should surface as
 * a clear 400, not as a half-created Vercel project.
 */

type Obj = Record<string, unknown>;

function obj(value: unknown, label: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${label} must be an object.`);
  return value as Obj;
}

function str(o: Obj, key: string, label: string, max = 500): string {
  const value = o[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw badRequest(`${label}.${key} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

function optStr(o: Obj, key: string, label: string, max = 500): string | null {
  const value = o[key];
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > max || /[\r\n]/.test(value)) {
    throw badRequest(`${label}.${key} must be a single-line string of at most ${max} characters, or null.`);
  }
  return value;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseDeployRequest(raw: unknown): DeployRequest {
  const body = obj(raw, "body");
  const component = obj(body.component, "component");
  const repo = obj(body.repo, "repo");

  const deploymentId = str(body, "deploymentId", "body", 64);
  const userId = str(body, "userId", "body", 64);
  const componentId = str(component, "id", "component", 64);
  if (![deploymentId, userId, componentId].every((id) => ID.test(id))) {
    throw badRequest("deploymentId, userId and component.id must be ids.");
  }

  const rootDir = str(component, "rootDir", "component");
  if (rootDir.startsWith("/") || rootDir.split("/").includes("..")) {
    throw badRequest("component.rootDir must be a relative folder inside the repository.");
  }

  const fullName = str(repo, "fullName", "repo", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw badRequest("repo.fullName must be owner/repo.");
  }
  const repoId = repo.repoId;
  if (typeof repoId !== "number" || !Number.isInteger(repoId) || repoId <= 0) {
    throw badRequest("repo.repoId must be GitHub's numeric repository id.");
  }

  const commitSha = str(body, "commitSha", "body", 40);
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw badRequest("commitSha must be a full 40-character commit SHA.");
  }

  const publicEnvVars =
    body.publicEnvVars !== undefined && body.publicEnvVars !== null ? parsePublicEnvVars(body.publicEnvVars) : undefined;
  const envVars =
    body.envVars !== undefined && body.envVars !== null
      ? parseUserEnvVars(body.envVars, new Set((publicEnvVars ?? []).map((v) => v.key)))
      : undefined;

  const githubToken = body.githubToken;
  if (githubToken !== undefined && githubToken !== null && (typeof githubToken !== "string" || githubToken.length > 500)) {
    throw badRequest("githubToken must be a string.");
  }

  return {
    deploymentId,
    userId,
    component: {
      id: componentId,
      name: str(component, "name", "component", 100),
      rootDir,
      framework: optStr(component, "framework", "component", 100),
      installCmd: optStr(component, "installCmd", "component"),
      buildCmd: optStr(component, "buildCmd", "component"),
      outputDir: optStr(component, "outputDir", "component"),
      nodeVersion: optStr(component, "nodeVersion", "component", 100),
    },
    repo: { fullName, repoId, branch: str(repo, "branch", "repo", 255) },
    commitSha: commitSha.toLowerCase(),
    githubToken: (githubToken as string | null | undefined) || undefined,
    ...(publicEnvVars ? { publicEnvVars } : {}),
    ...(envVars ? { envVars } : {}),
  };
}

const USER_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_USER_VARS = 100;
const MAX_VALUE_BYTES = 32 * 1024;
/** Vercel's runtime reserves these (docs, 2026-11-03); VERCEL_* are its system variables. */
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

/**
 * The user's env vars (Phase 9). The main backend validated them already; this
 * is the contract check. Messages name the key, never the value.
 */
export function parseUserEnvVars(raw: unknown, publicKeys: ReadonlySet<string> = new Set()): UserEnvVar[] {
  if (!Array.isArray(raw)) throw badRequest("envVars must be an array.");
  if (raw.length > MAX_USER_VARS) throw badRequest(`envVars holds more than ${MAX_USER_VARS} variables.`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const v = obj(item, `envVars[${index}]`);
    const key = typeof v.key === "string" ? v.key : "";
    if (!USER_KEY.test(key) || key.length > 255) throw badRequest(`envVars[${index}].key must be a variable name.`);
    const upper = key.toUpperCase();
    if (VERCEL_RESERVED.has(upper) || upper.startsWith("VERCEL_")) {
      throw badRequest(`envVars[${index}] (${key}) is reserved by Vercel.`);
    }
    if (seen.has(key)) throw badRequest(`envVars sets ${key} twice.`);
    seen.add(key);
    if (publicKeys.has(key)) throw badRequest(`envVars and publicEnvVars both set ${key}.`);
    if (typeof v.value !== "string" || Buffer.byteLength(v.value, "utf8") > MAX_VALUE_BYTES) {
      throw badRequest(`envVars[${index}] (${key}) needs a string value of at most 32 KB.`);
    }
    if (typeof v.secret !== "boolean") throw badRequest(`envVars[${index}] (${key}).secret must be true or false.`);
    return { key, value: v.value, secret: v.secret };
  });
}

const PUBLIC_KEY = /^[A-Z_][A-Z0-9_]*$/;
/** A guard, not a policy: these are stored and logged, so nothing secret-looking may come this way. */
const SECRET_LOOKING = /SECRET|TOKEN|KEY|PASSWORD|PASSWD|PRIVATE|CREDENTIAL/;

/**
 * Public env vars (the backend's URL for the frontend). Values are visible in
 * the browser bundle anyway, so they are stored with the request and may be
 * logged; anything that looks like a secret is refused.
 */
export function parsePublicEnvVars(raw: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(raw)) throw badRequest("publicEnvVars must be an array.");
  if (raw.length > 20) throw badRequest("publicEnvVars holds more than 20 variables.");
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const v = obj(item, `publicEnvVars[${index}]`);
    const key = typeof v.key === "string" ? v.key : "";
    if (!PUBLIC_KEY.test(key) || key.length > 128) {
      throw badRequest(`publicEnvVars[${index}].key must be an upper-case variable name.`);
    }
    if (SECRET_LOOKING.test(key)) {
      throw badRequest(`publicEnvVars[${index}] (${key}) looks like a secret; only public values may be sent here.`);
    }
    if (seen.has(key)) throw badRequest(`publicEnvVars sets ${key} twice.`);
    seen.add(key);
    if (typeof v.value !== "string" || v.value.length > 2048 || /[\r\n]/.test(v.value)) {
      throw badRequest(`publicEnvVars[${index}] (${key}) needs a single-line string value.`);
    }
    return { key, value: v.value };
  });
}

export function parseEnvVars(raw: unknown): EnvVarInput[] {
  const body = obj(raw, "body");
  if (!Array.isArray(body.vars)) throw badRequest("vars must be an array.");
  return body.vars.map((item, index) => {
    const v = obj(item, `vars[${index}]`);
    const key = str(v, "key", `vars[${index}]`, 256);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw badRequest(`vars[${index}].key is not a valid variable name.`);
    if (typeof v.value !== "string" || v.value.length > 65_536) {
      throw badRequest(`vars[${index}].value must be a string.`);
    }
    return { key, value: v.value };
  });
}
