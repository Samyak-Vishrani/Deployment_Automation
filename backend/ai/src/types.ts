/**
 * The shapes the AI service works with (Phase 13).
 *
 * The main backend mirrors ContextBundle and AnalysisView in
 * backend/lib/ai/ai-types.ts; change both together.
 */

import type { LogSource, RuntimeLogLine } from "@orbitops/integration-common/contract";

export type Provider = "vercel" | "render" | "neon" | "local_docker";
export type ComponentKind = "frontend" | "backend" | "database";
export type Scope = "project" | "component";

/** A build-log line from backend/logs' errors-first excerpt. `repeat` > 1 = this text ran n times in a row. */
export interface ExcerptEntry {
  seq: number;
  at: number;
  source: LogSource;
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

export interface BundleDeployment {
  id: string;
  status: string;
  trigger: string;
  commitSha: string | null;
  commitMessage: string | null;
  errorMessage: string | null;
  providerStatus: string | null;
  queuedAt: string;
  finishedAt: string | null;
}

export interface BundleComponent {
  id: string;
  name: string;
  kind: ComponentKind;
  provider: Provider;
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
  /** Env var KEYS only: its own, the shared ones it receives, the ones OrbitOps sets. Never a value. */
  env: { keys: string[]; sharedKeys: string[]; systemKeys: string[]; pendingRedeploy: boolean };
  /** Newest first. */
  deployments: BundleDeployment[];
  log: BundleLog | null;
  /** Component scope only: the last successful build, for comparison. */
  previousSuccessLog?: BundleLog | null;
  runtime: { lines: RuntimeLogLine[]; note: string | null } | null;
}

/** Everything the AI is told about a project. Built and redacted by the main backend; holds no secret value. */
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
  /** What the backend could not include (a logs-service outage, a missing log…). */
  notes: string[];
}

// ------------------------------------------------------------------ rules --

export type Category =
  | "MISSING_ENV_VARIABLE"
  | "MISSING_DEPENDENCY"
  | "TYPESCRIPT_ERROR"
  | "BUILD_COMMAND_FAILED"
  | "START_COMMAND_FAILED"
  | "PORT_BINDING"
  | "HEALTH_CHECK_FAILED"
  | "DATABASE_CONNECTION"
  | "DATABASE_MIGRATION"
  | "API_URL_MISMATCH"
  | "CORS"
  | "OUT_OF_MEMORY"
  | "TIMEOUT"
  | "PROVIDER_AUTH"
  | "PROVIDER_LIMIT"
  | "CONFIGURATION"
  | "RUNTIME_EXCEPTION"
  | "UNKNOWN";

export type Severity = "low" | "medium" | "high" | "critical";

/** A finding of the rule pass: a hypothesis for the model to verify, or the answer when there is no model. */
export interface Hypothesis {
  category: Category;
  severity: Severity;
  componentId: string | null;
  /** Lines (verbatim) that triggered the rule. */
  evidence: Array<{ componentId: string | null; source: string; line: string; deploymentId: string | null }>;
  /** What the rule saw, in words. */
  rule: string;
}

// ----------------------------------------------------------------- result --

export type Verdict = "healthy" | "degraded" | "failing" | "unknown";
export type StepWhere = "configure" | "settings" | "environment" | "repository" | "provider_dashboard" | "redeploy";

export interface Evidence {
  componentId: string | null;
  source: string;
  line: string;
  deploymentId: string | null;
}

export interface Problem {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  componentIds: string[];
  rootCause: string;
  confidence: number;
  evidence: Evidence[];
}

export interface Step {
  order: number;
  title: string;
  detail: string;
  problemIds: string[];
  where: StepWhere;
  componentId: string | null;
  command: string | null;
  file: string | null;
  envKey: string | null;
}

export interface AnalysisResult {
  verdict: Verdict;
  summary: string;
  problems: Problem[];
  steps: Step[];
  components: Array<{ componentId: string; status: "ok" | "warning" | "failing" | "unknown"; note: string }>;
  providerNotes: string | null;
  followUps: string[];
}

export interface AnalysisView {
  id: string;
  projectId: string;
  scope: Scope;
  componentId: string | null;
  deploymentId: string | null;
  question: string | null;
  engine: "openai" | "rules";
  model: string | null;
  cached: boolean;
  createdAt: string;
  result: AnalysisResult;
  /** Why the answer is rule-based, what was trimmed, what was missing. */
  notice: string | null;
  usage: { promptTokens: number; completionTokens: number; durationMs: number } | null;
  helpful: boolean | null;
}
