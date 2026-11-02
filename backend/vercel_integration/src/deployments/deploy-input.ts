import { badRequest } from "../http/provider-error";
import type { DeployRequest } from "../types";
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
  };
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
