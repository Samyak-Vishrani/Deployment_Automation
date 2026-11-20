import { badRequest } from "@orbitops/integration-common/provider-error";
import type { ContextBundle, Scope } from "../types";
import type { AnalyzeRequest } from "./analysis.service";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const MAX_QUESTION = 500;

export function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw badRequest(`${label} must be an id.`);
  return value;
}

/**
 * POST /analyses, from the main backend. The bundle is built by the backend
 * (a trusted caller), so only its outline is checked here: a contract drift
 * should be a clear 400, not a confusing prompt.
 */
export function parseAnalyzeRequest(raw: unknown): AnalyzeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Send a JSON object.");
  const body = raw as Record<string, unknown>;
  const scope = body.scope;
  if (scope !== "project" && scope !== "component") throw badRequest("scope must be project or component.");
  const componentId = body.componentId === null || body.componentId === undefined ? null : assertId(body.componentId, "componentId");
  if (scope === "component" && !componentId) throw badRequest("A component analysis needs componentId.");
  const deploymentId = body.deploymentId === null || body.deploymentId === undefined ? null : assertId(body.deploymentId, "deploymentId");

  let question: string | null = null;
  if (body.question !== undefined && body.question !== null) {
    if (typeof body.question !== "string") throw badRequest("question must be a string.");
    question = body.question.trim().slice(0, MAX_QUESTION) || null;
  }

  const bundle = body.bundle as ContextBundle | undefined;
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.components) || !bundle.project || !Array.isArray(bundle.preflight)) {
    throw badRequest("bundle must be a context bundle (project, preflight, components).");
  }
  if (bundle.components.length > 20) throw badRequest("At most 20 components per bundle.");
  if (!Array.isArray(bundle.notes)) bundle.notes = [];

  return {
    userId: assertId(body.userId, "userId"),
    projectId: assertId(body.projectId, "projectId"),
    scope: scope as Scope,
    componentId,
    deploymentId,
    question,
    force: body.force === true,
    bundle,
  };
}
