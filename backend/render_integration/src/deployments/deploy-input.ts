import { badRequest } from "../http/provider-error";
import type { DeployRequest, EnvVar } from "../types";

/**
 * Validates what the main backend sends. It is a trusted caller (it holds the
 * internal token), but a contract drift between two services should surface as
 * a clear 400, not as a half-created Render service.
 */

type Obj = Record<string, unknown>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_VARS = 200;
const MAX_ENV_VALUE = 65_536;

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

/** Env var values are never echoed in an error: only the index and the key. */
export function parseEnvVarList(value: unknown, label: string): EnvVar[] {
  if (!Array.isArray(value)) throw badRequest(`${label} must be an array.`);
  if (value.length > MAX_ENV_VARS) throw badRequest(`${label} holds more than ${MAX_ENV_VARS} variables.`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const v = obj(item, `${label}[${index}]`);
    const key = typeof v.key === "string" ? v.key : "";
    if (!ENV_KEY.test(key) || key.length > 256) {
      throw badRequest(`${label}[${index}].key is not a valid variable name.`);
    }
    if (seen.has(key)) throw badRequest(`${label} sets ${key} twice.`);
    seen.add(key);
    if (typeof v.value !== "string" || v.value.length > MAX_ENV_VALUE) {
      throw badRequest(`${label}[${index}] (${key}) needs a string value.`);
    }
    return { key, value: v.value };
  });
}

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

  const healthCheckPath = optStr(component, "healthCheckPath", "component", 200);
  if (healthCheckPath !== null && !healthCheckPath.startsWith("/")) {
    throw badRequest("component.healthCheckPath must start with /.");
  }

  const fullName = str(repo, "fullName", "repo", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw badRequest("repo.fullName must be owner/repo.");
  }

  const commitSha = str(body, "commitSha", "body", 40);
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw badRequest("commitSha must be a full 40-character commit SHA.");
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
      startCmd: optStr(component, "startCmd", "component"),
      nodeVersion: optStr(component, "nodeVersion", "component", 100),
      healthCheckPath,
    },
    repo: { fullName, branch: str(repo, "branch", "repo", 255) },
    commitSha: commitSha.toLowerCase(),
    envVars: body.envVars === undefined || body.envVars === null ? [] : parseEnvVarList(body.envVars, "envVars"),
  };
}

export function parseEnvVarsBody(raw: unknown): EnvVar[] {
  return parseEnvVarList(obj(raw, "body").vars, "vars");
}

export function parseRollbackBody(raw: unknown): { renderDeployId: string } {
  const body = obj(raw, "body");
  const renderDeployId = str(body, "renderDeployId", "body", 255);
  if (!/^[A-Za-z0-9_-]+$/.test(renderDeployId)) throw badRequest("renderDeployId must be a Render deploy id.");
  return { renderDeployId };
}
