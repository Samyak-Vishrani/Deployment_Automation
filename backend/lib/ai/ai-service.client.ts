import {
  IntegrationServiceClient,
  type IntegrationServiceConfig,
  type IntegrationServiceInfo,
} from "@/lib/providers/integration-service.client";
import type { AiScope, AnalysisSummary, AnalysisView, ContextBundle } from "./ai-types";

/**
 * Typed client for the AI service (backend/ai, :3006; Phase 13). It has its
 * own shared token, AI_SERVICE_TOKEN. The backend checks ownership and builds
 * the context bundle; the AI service holds the OpenAI key and the prompts.
 */

export const AI_SERVICE_UNAVAILABLE = "ai_service_unavailable";

const INFO: IntegrationServiceInfo = {
  label: "AI",
  folder: "backend/ai",
  unavailableCode: AI_SERVICE_UNAVAILABLE,
  tokenVar: "AI_SERVICE_TOKEN",
};

/** The AI service waits up to OPENAI_TIMEOUT_MS (45 s) with retries; this leaves it room. */
const ANALYZE_TIMEOUT_MS = 120_000;

export function loadAiServiceConfig(env: NodeJS.ProcessEnv = process.env): IntegrationServiceConfig {
  return {
    baseUrl: (env.AI_SERVICE_URL?.trim() || "http://127.0.0.1:3006").replace(/\/+$/, ""),
    token: env.AI_SERVICE_TOKEN?.trim() ?? "",
  };
}

export interface AnalyzeInput {
  userId: string;
  projectId: string;
  scope: AiScope;
  componentId: string | null;
  deploymentId: string | null;
  question: string | null;
  force: boolean;
  bundle: ContextBundle;
}

const enc = encodeURIComponent;

export class AiServiceClient extends IntegrationServiceClient {
  constructor(loadConfig: () => IntegrationServiceConfig = loadAiServiceConfig, timeoutMs = 15_000) {
    super(INFO, loadConfig, timeoutMs);
  }

  analyze(input: AnalyzeInput): Promise<AnalysisView> {
    return this.call("POST", "/analyses", input, ANALYZE_TIMEOUT_MS);
  }

  list(userId: string, projectId: string, take = 10): Promise<AnalysisSummary[]> {
    return this.call("GET", `/analyses?userId=${enc(userId)}&projectId=${enc(projectId)}&take=${take}`);
  }

  get(userId: string, id: string): Promise<AnalysisView> {
    return this.call("GET", `/analyses/${enc(id)}?userId=${enc(userId)}`);
  }

  feedback(userId: string, id: string, helpful: boolean): Promise<{ id: string; helpful: boolean }> {
    return this.call("POST", `/analyses/${enc(id)}/feedback`, { userId, helpful });
  }
}
