import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { ProviderError, ServiceError } from "@orbitops/integration-common/provider-error";
import { estimateTokens, fitBundle } from "../budget/fit";
import type { Db } from "../db";
import type { LlmClient } from "../llm/openai";
import { systemPrompt } from "../prompts/system";
import { userPrompt } from "../prompts/user";
import { classify } from "../rules/classify";
import { ruleBasedResult } from "../rules/fallback";
import { ANALYSIS_SCHEMA } from "../schema";
import { combinedTimeline, renderTimeline } from "../timeline/timeline";
import type { AnalysisResult, AnalysisView, ContextBundle, Scope } from "../types";
import { InvalidAnalysisError, validateResult } from "../validate";
import { redactBundle } from "./redact-bundle";

export interface AnalyzeRequest {
  userId: string;
  projectId: string;
  scope: Scope;
  componentId: string | null;
  deploymentId: string | null;
  question: string | null;
  force: boolean;
  bundle: ContextBundle;
}

export interface AnalysisOptions {
  maxInputTokens: number;
  maxOutputTokens: number;
  rateHour: number;
  rateDay: number;
  cacheMinutes: number;
}

export interface AnalysisSummary {
  id: string;
  scope: Scope;
  componentId: string | null;
  deploymentId: string | null;
  question: string | null;
  engine: "openai" | "rules";
  verdict: string | null;
  summary: string | null;
  createdAt: string;
  helpful: boolean | null;
}

type Row = Prisma.AiAnalysisGetPayload<object>;

/** Room left for the system prompt, playbooks and the schema around the context. */
const PROMPT_OVERHEAD_TOKENS = 3_000;

/**
 * Runs one analysis (Phase 13): rules → budget → combined timeline → prompt →
 * OpenAI → validation and the evidence guard → stored. Without a model, or
 * when the model fails, the answer is the rule-based one, said so in
 * `notice`. Analyses are the cache (same input within cacheMinutes) and the
 * rate-limit ledger.
 */
export class AnalysisService {
  private readonly running = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly llm: LlmClient | null,
    private readonly options: AnalysisOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get engine(): { openaiConfigured: boolean; model: string | null } {
    return { openaiConfigured: Boolean(this.llm), model: this.llm?.model ?? null };
  }

  async analyze(request: AnalyzeRequest): Promise<AnalysisView> {
    if (request.scope === "component" && !request.bundle.components.some((c) => c.id === request.componentId)) {
      throw new ServiceError("The component to analyse is not in the context bundle.", 400, "bad_request");
    }

    const bundle = redactBundle(request.bundle);
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ scope: request.scope, componentId: request.componentId, deploymentId: request.deploymentId, question: request.question, bundle }))
      .digest("hex");

    if (!request.force) {
      const since = new Date(this.now().getTime() - this.options.cacheMinutes * 60_000);
      const cached = await this.db.aiAnalysis.findFirst({
        where: { userId: request.userId, inputHash, status: "done", createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
      });
      if (cached) return { ...toView(cached), cached: true };
    }

    await this.checkRate(request.userId);
    const lock = request.projectId;
    if (this.running.has(lock)) {
      throw new ServiceError("An analysis of this project is already running. Wait for it to finish.", 409, "ai_busy");
    }
    this.running.add(lock);
    try {
      return await this.run(request, bundle, inputHash);
    } finally {
      this.running.delete(lock);
    }
  }

  async list(userId: string, projectId: string, take = 10): Promise<AnalysisSummary[]> {
    const rows = await this.db.aiAnalysis.findMany({
      where: { userId, projectId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(1, take), 50),
    });
    return rows.map((r) => {
      const result = r.result as unknown as AnalysisResult | null;
      return {
        id: r.id,
        scope: r.scope as Scope,
        componentId: r.componentId,
        deploymentId: r.deploymentId,
        question: r.question,
        engine: r.engine as "openai" | "rules",
        verdict: result?.verdict ?? null,
        summary: result?.summary ?? r.notice,
        createdAt: r.createdAt.toISOString(),
        helpful: r.helpful,
      };
    });
  }

  async get(userId: string, id: string): Promise<AnalysisView> {
    const row = await this.db.aiAnalysis.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw new ServiceError("No such analysis.", 404, "not_found");
    return toView(row);
  }

  async feedback(userId: string, id: string, helpful: boolean): Promise<{ id: string; helpful: boolean }> {
    const row = await this.db.aiAnalysis.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw new ServiceError("No such analysis.", 404, "not_found");
    await this.db.aiAnalysis.update({ where: { id }, data: { helpful } });
    return { id, helpful };
  }

  // ------------------------------------------------------------- internals --

  private async run(request: AnalyzeRequest, bundle: ContextBundle, inputHash: string): Promise<AnalysisView> {
    const started = Date.now();
    const target = request.scope === "component" ? request.componentId : null;
    const allHypotheses = classify(bundle);
    const hypotheses = target ? allHypotheses.filter((h) => h.componentId === target) : allHypotheses;
    const fitted = fitBundle(bundle, hypotheses, Math.max(2_000, this.options.maxInputTokens - PROMPT_OVERHEAD_TOKENS));
    const notes = [...fitted.notes];

    let result: AnalysisResult;
    let engine: "openai" | "rules" = "rules";
    let model: string | null = null;
    let usage: { promptTokens: number; completionTokens: number } | null = null;

    if (this.llm) {
      try {
        const system = systemPrompt(request.scope);
        const user = userPrompt({
          scope: request.scope,
          bundle: fitted.bundle,
          targetComponentId: target,
          hypotheses,
          timeline: request.scope === "project" ? renderTimeline(combinedTimeline(fitted.bundle)) : "",
          budgetNotes: fitted.notes,
          question: request.question,
        });
        const out = await this.llm.complete({ system, user, schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>, maxTokens: this.options.maxOutputTokens });
        const validated = validateResult(out.json, fitted.bundle);
        result = validated.result;
        notes.push(...validated.warnings);
        engine = "openai";
        model = out.model;
        usage = out.usage;
        if (estimateTokens(system + user) > this.options.maxInputTokens * 1.2) notes.push("The context was larger than planned.");
      } catch (error) {
        const reason =
          error instanceof ProviderError ? `${error.message} (${error.code})` : error instanceof InvalidAnalysisError ? error.message : "The AI call failed.";
        notes.unshift(`The AI could not answer, so this is the rule-based diagnosis. ${reason}`);
        result = ruleBasedResult(fitted.bundle, hypotheses, request.scope);
      }
    } else {
      notes.unshift("No OPENAI_API_KEY is set in backend/ai/.env, so this is the rule-based diagnosis.");
      result = ruleBasedResult(fitted.bundle, hypotheses, request.scope);
    }

    if (request.scope === "component" && target) {
      result = { ...result, components: result.components.filter((c) => c.componentId === target) };
    }

    const row = await this.db.aiAnalysis.create({
      data: {
        userId: request.userId,
        projectId: request.projectId,
        scope: request.scope,
        componentId: request.componentId,
        deploymentId: request.deploymentId,
        question: request.question,
        inputHash,
        engine,
        model,
        status: "done",
        result: result as unknown as Prisma.InputJsonValue,
        notice: notes.length ? notes.join(" ") : null,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        durationMs: Date.now() - started,
      },
    });
    return toView(row);
  }

  private async checkRate(userId: string): Promise<void> {
    const now = this.now().getTime();
    const [hour, day] = await Promise.all([
      this.db.aiAnalysis.count({ where: { userId, createdAt: { gte: new Date(now - 3_600_000) } } }),
      this.db.aiAnalysis.count({ where: { userId, createdAt: { gte: new Date(now - 86_400_000) } } }),
    ]);
    if (hour >= this.options.rateHour || day >= this.options.rateDay) {
      throw new ServiceError(
        hour >= this.options.rateHour
          ? `At most ${this.options.rateHour} AI analyses an hour. Try again later, or open a recent one from the history.`
          : `At most ${this.options.rateDay} AI analyses a day. Try again tomorrow.`,
        429,
        "ai_rate_limited",
      );
    }
  }
}

function toView(row: Row): AnalysisView {
  return {
    id: row.id,
    projectId: row.projectId,
    scope: row.scope as Scope,
    componentId: row.componentId,
    deploymentId: row.deploymentId,
    question: row.question,
    engine: row.engine as "openai" | "rules",
    model: row.model,
    cached: false,
    createdAt: row.createdAt.toISOString(),
    result: row.result as unknown as AnalysisResult,
    notice: row.notice,
    usage:
      row.promptTokens !== null
        ? { promptTokens: row.promptTokens, completionTokens: row.completionTokens ?? 0, durationMs: row.durationMs ?? 0 }
        : row.durationMs !== null
          ? { promptTokens: 0, completionTokens: 0, durationMs: row.durationMs }
          : null,
    helpful: row.helpful,
  };
}
