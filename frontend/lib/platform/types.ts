export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type DeploymentStatus = "deploying" | "healthy" | "failed" | "rolled-back";
export type HealthStatus = "passing" | "warning" | "failing";
export type SimulationMode = "success" | "failure";

export type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarInitials: string;
  avatarUrl?: string | null;
  githubUsername?: string | null;
};

export type Session = {
  user: User;
};

export type Repository = {
  provider: "github";
  owner: string;
  name: string;
  branch: string;
  url: string;
  connected: boolean;
  lastSyncAt: string;
};

export type DeploymentConfig = {
  environment: "development" | "staging" | "production";
  port: number;
  healthPath: string;
  buildPreset: "nextjs" | "node" | "docker";
};

export type Project = {
  id: string;
  name: string;
  slug: string;
  description: string;
  repo: Repository;
  config: DeploymentConfig;
  status: "healthy" | "degraded" | "offline";
  createdAt: string;
  latestRunId?: string;
  latestDeploymentId?: string;
};

export type ProjectInput = {
  name: string;
  slug: string;
  description: string;
  repoUrl: string;
  branch: string;
  environment: DeploymentConfig["environment"];
  port: number;
  healthPath: string;
  buildPreset: DeploymentConfig["buildPreset"];
};

export type PipelineStage = {
  id: string;
  name: string;
  status: StageStatus;
  detail: string;
  duration?: string;
};

export type PipelineRun = {
  id: string;
  projectId: string;
  number: number;
  branch: string;
  commitSha: string;
  commitMessage: string;
  triggeredBy: string;
  triggerType: "manual" | "push";
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  duration?: string;
  workflowUrl: string;
  stages: PipelineStage[];
  simulation: SimulationMode;
  failureReason?: string;
};

export type Deployment = {
  id: string;
  projectId: string;
  runId: string;
  version: string;
  environment: DeploymentConfig["environment"];
  status: DeploymentStatus;
  url: string;
  image: string;
  commitSha: string;
  createdAt: string;
  finishedAt?: string;
  healthScore: number;
  replicas: number;
  readyReplicas: number;
};

export type LogEntry = {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  source: string;
};

export type HealthCheck = {
  name: string;
  status: HealthStatus;
  latencyMs: number;
  detail: string;
};

export type AiInsight = {
  id: string;
  projectId: string;
  runId?: string;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  probableCause: string;
  recommendedAction: string;
  confidence: number;
  createdAt: string;
  evidence: string[];
};

export type PlatformProvider = {
  logout(): Promise<void>;
  getSession(): Promise<Session | null>;
  listProjects(): Promise<Project[]>;
  createProject(input: ProjectInput): Promise<Project>;
  getProject(projectId: string): Promise<Project | null>;
  listPipelineRuns(projectId: string): Promise<PipelineRun[]>;
  getPipelineRun(runId: string): Promise<PipelineRun | null>;
  triggerPipeline(projectId: string, simulation?: SimulationMode): Promise<PipelineRun>;
  cancelPipeline(runId: string): Promise<PipelineRun | null>;
  redeploy(deploymentId: string): Promise<Deployment | null>;
  listDeployments(projectId: string): Promise<Deployment[]>;
  getDeploymentLogs(deploymentId: string): Promise<LogEntry[]>;
  getPipelineLogs(runId: string): Promise<LogEntry[]>;
  getHealthChecks(projectId: string): Promise<HealthCheck[]>;
  getAiInsights(projectId: string): Promise<AiInsight[]>;
};

export const PIPELINE_STAGE_NAMES = [
  "Checkout",
  "Test",
  "Build image",
  "Push image",
  "Deploy",
  "Health check",
] as const;
