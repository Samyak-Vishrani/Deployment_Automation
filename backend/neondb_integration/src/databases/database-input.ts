import { badRequest } from "@orbitops/integration-common/provider-error";
import { asObject, assertId, rejectUnknownKeys } from "../credentials/credential-input";
import type { DatabaseRequest } from "../types";

function label(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n]/.test(value)) {
    throw badRequest(`${key} must be a single-line string of 1 to ${max} characters.`);
  }
  return value.trim();
}

/**
 * POST /databases from the main backend. A trusted caller, but a contract
 * drift between two services should surface as a clear 400.
 */
export function parseDatabaseRequest(raw: unknown): DatabaseRequest {
  const body = asObject(raw);
  rejectUnknownKeys(body, ["userId", "componentId", "projectName", "componentName"]);
  return {
    userId: assertId(body.userId, "userId"),
    componentId: assertId(body.componentId, "componentId"),
    projectName: label(body, "projectName", 200),
    componentName: label(body, "componentName", 100),
  };
}
