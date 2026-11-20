import { badRequest } from "@/lib/api/http-error";
import type { AiServiceClient } from "./ai-service.client";
import type { AnalysisSummary, AnalysisView } from "./ai-types";
import type { AiContextBuilder } from "./context-builder";

export const MAX_QUESTION = 500;

export interface AskOptions {
  question?: string | null;
  deploymentId?: string | null;
  force?: boolean;
}

/** `{ question?, deploymentId?, force? }` from a request body; the question is trimmed and capped. */
export function parseAskBody(raw: unknown): AskOptions {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Send a JSON object.");
  const body = raw as Record<string, unknown>;
  if (body.question !== undefined && body.question !== null && typeof body.question !== "string") throw badRequest("question must be text.");
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question.length > MAX_QUESTION) throw badRequest(`The question is longer than ${MAX_QUESTION} characters.`);
  if (body.deploymentId !== undefined && body.deploymentId !== null && typeof body.deploymentId !== "string") throw badRequest("deploymentId must be an id.");
  return {
    question: question || null,
    deploymentId: typeof body.deploymentId === "string" ? body.deploymentId : null,
    force: body.force === true,
  };
}

/**
 * The AI assistant from the main backend's side (Phase 13): checks ownership
 * (through the context builder), gathers the context, and asks the AI
 * service. On demand only: nothing here runs on its own.
 */
export class AiService {
  constructor(
    private readonly client: Pick<AiServiceClient, "analyze" | "list" | "get" | "feedback">,
    private readonly context: Pick<AiContextBuilder, "forProject" | "forComponent">,
  ) {}

  /** The whole project: is anything wrong, what, and the steps to fix it. */
  async diagnose(userId: string, projectId: string, options: AskOptions): Promise<AnalysisView> {
    const bundle = await this.context.forProject(userId, projectId);
    return this.client.analyze({
      userId,
      projectId,
      scope: "project",
      componentId: null,
      deploymentId: null,
      question: options.question ?? null,
      force: options.force ?? false,
      bundle,
    });
  }

  /** One component (or "docker") on its own, optionally one of its deployments. */
  async analyzeComponent(userId: string, projectId: string, componentId: string, options: AskOptions): Promise<AnalysisView> {
    const bundle = await this.context.forComponent(userId, projectId, componentId, options.deploymentId ?? null);
    return this.client.analyze({
      userId,
      projectId,
      scope: "component",
      componentId,
      deploymentId: options.deploymentId ?? null,
      question: options.question ?? null,
      force: options.force ?? false,
      bundle,
    });
  }

  /** The project's past analyses (the route checks the user owns the project first). */
  list(userId: string, projectId: string, take: number): Promise<AnalysisSummary[]> {
    return this.client.list(userId, projectId, Math.min(Math.max(1, take), 50));
  }

  /** The AI service checks the analysis belongs to the user. */
  get(userId: string, id: string): Promise<AnalysisView> {
    return this.client.get(userId, id);
  }

  feedback(userId: string, id: string, helpful: boolean): Promise<{ id: string; helpful: boolean }> {
    return this.client.feedback(userId, id, helpful);
  }
}
