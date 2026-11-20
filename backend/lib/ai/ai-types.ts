/**
 * The AI service's contract (Phase 13), mirrored from backend/ai/src/types.ts;
 * change both together. The context bundle holds env var KEYS only, never a
 * value.
 */
import type { RuntimeLogLine } from "@/lib/logs/log-types";

export type AiScope = "project" | "component";

export interface ExcerptEntry {
  seq: number;
  at: number;
  source: "orbitops" | "vercel" | "render" | "neon" | "docker";
  stream: "info" | "stdout" | "stderr";
  text: string;
  repeat?: number;
}

export interface BundleLog {
  deploymentId: string;
  entries: ExcerptEntry[];
  totalLines: number;
  errorLines: number;
  truncated: boolean;
}

export interface BundleComponent {
  id: string;
  name: string;
  kind: "frontend" | "backend" | "database";
  provider: "vercel" | "render" | "neon" | "local_docker";
  settings: {
    rootDir: string;
    framework: string | null;
    installCmd: string | null;
    buildCmd: string | null;
    startCmd: string | null;
    outputDir: string | null;
    nodeVersion: string | null;
    healthCheckPath: string | null;
  };
  status: string;
  url: string | null;
  env: { keys: string[]; sharedKeys: string[]; systemKeys: string[]; pendingRedeploy: boolean };
  deployments: Array<{
    id: string;
    status: string;
    trigger: string;
    commitSha: string | null;
    commitMessage: string | null;
    errorMessage: string | null;
    providerStatus: string | null;
    queuedAt: string;
    finishedAt: string | null;
  }>;
  log: BundleLog | null;
  previousSuccessLog?: BundleLog | null;
  runtime: { lines: RuntimeLogLine[]; note: string | null } | null;
}

export interface ContextBundle {
  project: { name: string; repo: string | null; branch: string | null; createdAt: string };
  repoAnalysis: {
    components: Array<{ path: string | null; framework: string | null; role: string | null }>;
    database: { detected: boolean; engine: string | null } | null;
  } | null;
  preflight: Array<{ id: string; status: "pass" | "fail" | "pending"; message: string }>;
  release: {
    number: number;
    status: string;
    stage: number;
    errorMessage: string | null;
    steps: Array<{ kind: string; componentName: string; status: string | null }>;
  } | null;
  components: BundleComponent[];
  notes: string[];
}

export interface AnalysisResult {
  verdict: "healthy" | "degraded" | "failing" | "unknown";
  summary: string;
  problems: Array<{
    id: string;
    title: string;
    severity: "low" | "medium" | "high" | "critical";
    category: string;
    componentIds: string[];
    rootCause: string;
    confidence: number;
    evidence: Array<{ componentId: string | null; source: string; line: string; deploymentId: string | null }>;
  }>;
  steps: Array<{
    order: number;
    title: string;
    detail: string;
    problemIds: string[];
    where: "configure" | "settings" | "environment" | "repository" | "provider_dashboard" | "redeploy";
    componentId: string | null;
    command: string | null;
    file: string | null;
    envKey: string | null;
  }>;
  components: Array<{ componentId: string; status: "ok" | "warning" | "failing" | "unknown"; note: string }>;
  providerNotes: string | null;
  followUps: string[];
}

export interface AnalysisView {
  id: string;
  projectId: string;
  scope: AiScope;
  componentId: string | null;
  deploymentId: string | null;
  question: string | null;
  engine: "openai" | "rules";
  model: string | null;
  cached: boolean;
  createdAt: string;
  result: AnalysisResult;
  notice: string | null;
  usage: { promptTokens: number; completionTokens: number; durationMs: number } | null;
  helpful: boolean | null;
}

export interface AnalysisSummary {
  id: string;
  scope: AiScope;
  componentId: string | null;
  deploymentId: string | null;
  question: string | null;
  engine: "openai" | "rules";
  verdict: string | null;
  summary: string | null;
  createdAt: string;
  helpful: boolean | null;
}
