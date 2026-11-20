/**
 * Shapes returned by the push-to-deploy endpoints.
 *
 * Separate from lib/platform/types.ts on purpose: that file describes the
 * mock-driven workspace the dashboard is built on, where a "Deployment" is a
 * Kubernetes-flavoured release with replicas and a health score. These are the
 * real rows the backend stores, and conflating the two would mean one of the
 * two screens lying about what it is showing.
 */

export type DeploymentStatus = "queued" | "running" | "success" | "failed" | "cancelled";
export type DeploymentTrigger = "push" | "manual" | "rollback";

export type DeployProject = {
  id: string;
  name: string;
  slug: string | null;
  repoId: number | null;
  repoFullName: string | null;
  owner: string | null;
  repo: string | null;
  branch: string | null;
  autoDeploy: boolean;
  watchPaths: string[];
  dockerfilePath: string;
  buildContext: string;
  containerPort: number;
  hostPort: number | null;
  currentImageTag: string | null;
  previousImageTag: string | null;
  /** Keys only. The backend never sends env var values to the browser. */
  envKeys: string[];
  createdAt: string;
};

export type DeployRun = {
  id: string;
  projectId: string;
  /** The component this deployed; null for the project-wide local Docker builds. */
  componentId: string | null;
  provider: ProviderId;
  /** The provider's own progress, finer than `status` (Vercel: building, live...). */
  providerStatus: ProviderStatus | null;
  providerDeploymentId: string | null;
  /** "git": the provider read the repo itself. "upload": we sent the files. */
  sourceMode: "git" | "upload" | null;
  /** This deployment's own URL on the provider. */
  url: string | null;
  /** The provider's dashboard page for this deployment. */
  inspectorUrl: string | null;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  branch: string;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  imageTag: string | null;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The "Deploy all" this belongs to (Phase 8); null for single deploys and pushes. */
  releaseId?: string | null;
};

export type CreateDeployProjectInput = {
  repoUrl: string;
  name?: string;
  slug?: string;
  branch?: string;
  containerPort?: number;
  dockerfilePath?: string;
  watchPaths?: string[];
  envVars?: Record<string, string>;
};

/** An installation of the GitHub App the signed-in user can see. */
export type GithubInstallation = {
  id: string;
  account: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  /** GitHub's settings page for the installation, where repositories are added. */
  manageUrl: string;
};

/** A repository the signed-in user can connect. */
export type GithubRepository = {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  installationId: string;
  pushedAt: string | null;
  /** Set when this user already has a project for the repository. */
  projectId: string | null;
};

export type RepositoryList = {
  installUrl: string;
  installations: GithubInstallation[];
  repositories: GithubRepository[];
  /** Some installation has more repositories than the list holds. */
  truncated: boolean;
};

export type BranchList = {
  defaultBranch: string;
  branches: Array<{ name: string; protected: boolean }>;
};

/** One message on the backend's /api/events feed. Identifiers only; refetch for data. */
export type AppEvent =
  | { kind: "deployment"; projectId: string; deploymentId: string; status: string }
  | { kind: "project"; projectId: string; action: "created" | "updated" | "deleted" }
  | { kind: "github"; action: string }
  /** A "Deploy all" moved on (Phase 8): stage 0 database, 1 backend, 2 frontend, 3 done. */
  | { kind: "release"; projectId: string; releaseId: string; status: string; stage: number };

export type ComponentRole = "frontend" | "backend" | "unknown";

/** One deployable app the repository analysis found, with the commands it proposes. */
export type AnalysisComponent = {
  id: string;
  type: string;
  role: ComponentRole | null;
  framework: string | null;
  language: string | null;
  /** Folder within the repository; "." is the root. */
  path: string | null;
  packageManager: string | null;
  detectedVersion: string | null;
  /** 0..1 */
  confidence: number | null;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  outputDir: string | null;
  runtimeVersion: string | null;
  /** Which files and dependencies triggered the detection. */
  evidence: string[];
};

export type AnalysisWarning = {
  code: string;
  message: string;
  path?: string;
};

export type DatabaseHint = {
  detected: boolean;
  engine: "postgres" | "mysql" | "mongodb" | "sqlite" | "unknown";
  evidence: string[];
  suggestNeon: boolean;
};

/** The latest analysis snapshot. `analysisId` is null until one has succeeded. */
export type ProjectAnalysis = {
  projectId: string;
  projectName: string;
  repository: string;
  analysisId: string | null;
  branch: string | null;
  commitSha: string | null;
  source: "tree" | "tarball" | null;
  /** ISO timestamp, or "" when there is no analysis yet. */
  analyzedAt: string;
  /** True when the commit had already been analysed and that snapshot was returned. */
  reused: boolean;
  warnings: AnalysisWarning[];
  database: DatabaseHint | null;
  components: AnalysisComponent[];
};

export type ComponentKind = "frontend" | "backend" | "database";
export type ProviderId = "vercel" | "render" | "neon" | "local_docker";
export type ComponentStatus = "draft" | "configured" | "deploying" | "live" | "failed";

/** The fields of a component the user edits on the configure screen. */
export type ComponentFields = {
  kind: ComponentKind;
  name: string;
  /** Folder within the repository; "." is the root. */
  rootDir: string;
  framework: string | null;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  outputDir: string | null;
  nodeVersion: string | null;
  /** Path the provider checks once the service is up, e.g. "/health". Backends only. */
  healthCheckPath: string | null;
  provider: ProviderId;
  analysisComponentId: string | null;
};

/** A saved deployable component. Separate from AnalysisComponent: re-analysing never changes it. */
export type DeployComponent = ComponentFields & {
  id: string;
  projectId: string;
  /** The provider's id for it, set once a provider phase has deployed it. */
  providerResourceId: string | null;
  url: string | null;
  status: ComponentStatus;
  createdAt: string;
  updatedAt: string;
};

/** A component the analysis suggests. `kind` and `provider` are null when it could not tell. */
export type ProposedComponent = Omit<ComponentFields, "kind" | "provider"> & {
  kind: ComponentKind | null;
  provider: ProviderId | null;
  evidence: string[];
  confidence: number | null;
};

export type ComponentProposal = {
  analysisId: string | null;
  branch: string | null;
  commitSha: string | null;
  analyzedAt: string;
  components: ProposedComponent[];
};

export type PreflightCheck = {
  id: string;
  componentId?: string;
  status: "pass" | "fail" | "pending";
  message: string;
};

export type PreflightResult = {
  /** Every check passed: the whole project can deploy. */
  ok: boolean;
  checks: PreflightCheck[];
  /** Per component id: its own checks pass and its provider can deploy it now. */
  deployable: Record<string, boolean>;
};

/** A provider deployment's progress, the same words for every provider. */
export type ProviderStatus = "queued" | "deploying" | "building" | "live" | "failed" | "cancelled";

export type CredentialState = "connected" | "invalid" | "missing" | "unavailable";

/** The user's account with a provider. Never includes the token or key. */
export type ProviderCredential = {
  provider: ProviderId;
  state: CredentialState;
  accountName?: string | null;
  /** Vercel: the team new projects are created in. */
  teamId?: string | null;
  teamSlug?: string | null;
  teams?: Array<{ id: string; slug: string; name: string }>;
  /** Render: the workspace new services are created in. */
  ownerId?: string | null;
  ownerName?: string | null;
  owners?: Array<{ id: string; name: string; type: string }>;
  /** Render: defaults for new services (fixed per service once it exists). */
  region?: string | null;
  plan?: string | null;
  /** Neon: the organization new projects are created in (null = the key's default). */
  orgId?: string | null;
  orgName?: string | null;
  orgs?: Array<{ id: string; name: string }>;
  /** Neon: defaults for new databases (fixed per project once it exists). */
  regionId?: string | null;
  pgVersion?: number | null;
  /** Something already exists in the current team/workspace, so it is fixed. */
  scopeLocked?: boolean;
  lastValidatedAt?: string | null;
  /** Why the state is "unavailable". */
  message?: string;
};

/** The MVP rule, mirrored from the backend: one provider per kind. */
export const PROVIDER_FOR_KIND: Record<ComponentKind, ProviderId> = {
  frontend: "vercel",
  backend: "render",
  database: "neon",
};

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  vercel: "Vercel",
  render: "Render",
  neon: "Neon",
  local_docker: "Local Docker",
};

export const isFinished = (status: DeploymentStatus) =>
  status === "success" || status === "failed" || status === "cancelled";

/** Providers that can deploy today. A Neon database "deploys" by being provisioned (Phase 8). */
export const CAN_DEPLOY: ReadonlySet<ProviderId> = new Set<ProviderId>(["vercel", "render", "neon", "local_docker"]);

/** Providers whose account is connected in Settings → Integrations. */
export type ConnectableProvider = "vercel" | "render" | "neon";

/** Neon regions for new databases. Oregon sits next to Render's default region. */
export const NEON_REGIONS = [
  { id: "aws-us-east-1", label: "AWS US East (N. Virginia)" },
  { id: "aws-us-east-2", label: "AWS US East (Ohio)" },
  { id: "aws-us-west-2", label: "AWS US West (Oregon)" },
  { id: "aws-eu-central-1", label: "AWS Europe (Frankfurt)" },
  { id: "aws-eu-west-2", label: "AWS Europe (London)" },
  { id: "aws-ap-southeast-1", label: "AWS Asia Pacific (Singapore)" },
  { id: "aws-ap-southeast-2", label: "AWS Asia Pacific (Sydney)" },
  { id: "aws-sa-east-1", label: "AWS South America (São Paulo)" },
  { id: "azure-eastus2", label: "Azure East US 2 (Virginia)" },
  { id: "azure-westus3", label: "Azure West US 3 (Arizona)" },
  { id: "azure-gwc", label: "Azure Germany West Central (Frankfurt)" },
] as const;

export const NEON_PG_VERSIONS = [17, 16, 15] as const;

/** The env vars a Neon database gives the backend. Names only; values never reach the browser. */
export const DATABASE_ENV_KEYS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const;

export type ReleaseStatus = "running" | "success" | "failed" | "cancelled";

/** One component's step in a release, with its deployment once started. */
export type ReleaseStep = {
  /** 0 database, 1 backend, 2 frontend. */
  stage: number;
  kind: ComponentKind;
  componentId: string;
  componentName: string;
  provider: ProviderId;
  deployment: {
    id: string;
    status: DeploymentStatus;
    providerStatus: string | null;
    url: string | null;
    errorMessage: string | null;
    queuedAt: string;
    finishedAt: string | null;
  } | null;
};

/** One "Deploy all" click: the project's components in order, at one commit. */
export type Release = {
  id: string;
  projectId: string;
  /** Per-project sequence, shown as #12. */
  number: number;
  status: ReleaseStatus;
  /** 0 database, 1 backend, 2 frontend, 3 done. */
  stage: number;
  trigger: string;
  branch: string;
  commitSha: string;
  commitMessage: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  steps: ReleaseStep[];
};

export const RENDER_REGIONS = [
  { id: "oregon", label: "Oregon (US West)" },
  { id: "ohio", label: "Ohio (US East)" },
  { id: "virginia", label: "Virginia (US East)" },
  { id: "frankfurt", label: "Frankfurt (EU)" },
  { id: "singapore", label: "Singapore (Asia)" },
] as const;

export const RENDER_PLANS = [
  { id: "free", label: "Free (sleeps after 15 min idle)" },
  { id: "starter", label: "Starter (paid)" },
  { id: "standard", label: "Standard (paid)" },
] as const;

/** Maps a build status onto the tones StatusPill already knows. */
export function pillStatus(status: DeploymentStatus) {
  switch (status) {
    case "queued":
      return "queued" as const;
    case "running":
      return "running" as const;
    case "success":
      return "succeeded" as const;
    case "failed":
      return "failed" as const;
    case "cancelled":
      return "canceled" as const;
  }
}

export function duration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const ms = new Date(end ?? Date.now()).getTime() - new Date(start).getTime();
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// ------------------------------------------------------ env vars (Phase 9) --

/** A stored env var as the API shows it: never its value. */
export type EnvVarView = { key: string; isSecret: boolean; updatedAt: string };

/** Set by OrbitOps at deploy time. Keys only; the values are never stored. */
export type SystemEnvView = {
  key: string;
  source: "neon" | "backend";
  /** The component it comes from. */
  from: string;
  /** A user value of the same key is used instead (the API URL); false = the system value wins (Neon). */
  userWins: boolean;
};

export type ComponentEnvView = {
  componentId: string;
  name: string;
  kind: ComponentKind;
  provider: ProviderId;
  vars: EnvVarView[];
  system: SystemEnvView[];
  /** Backends also get the shared set. */
  receivesShared: boolean;
  revision: number;
  /** Saved env changes its running deployment does not have yet. */
  pendingRedeploy: boolean;
};

export type EnvironmentView = {
  projectId: string;
  /** Sent to every backend and to local Docker deploys. */
  shared: EnvVarView[];
  components: ComponentEnvView[];
};

/** One row of a PUT. `value` omitted = keep the stored value. */
export type EnvPutEntry = { key: string; value?: string; isSecret: boolean };

export type EnvSuggestion = {
  key: string;
  /** The .env.example value, only for keys that do not look secret. */
  example: string | null;
  looksSecret: boolean;
  alreadySet: boolean;
  providedBySystem: boolean;
};

export type EnvSuggestions = { path: string; found: boolean; suggestions: EnvSuggestion[] };

// ------------------------------------------------------------ logs (Phase 12) --

/** Who wrote a build-log line. */
export type LogSource = "orbitops" | "vercel" | "render" | "neon" | "docker";
export type LogPhase = "setup" | "build" | "deploy" | "runtime";

/** One stored build-log line of ONE deployment (`seq` is its SSE id). */
export type DeployLogEntry = {
  seq: number;
  at: number;
  source: LogSource;
  phase: LogPhase;
  stream: "info" | "stdout" | "stderr";
  text: string;
};

/** One live line of a running app (never stored). */
export type RuntimeLogEntry = {
  id: string;
  at: number;
  source: LogSource;
  stream: "stdout" | "stderr";
  level?: string;
  text: string;
  request?: { method?: string; path?: string; status?: number };
};

export type LogsIndexDeployment = {
  id: string;
  status: DeploymentStatus;
  trigger: string;
  queuedAt: string;
  finishedAt: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  releaseNumber: number | null;
};

export type LogsIndexComponent = {
  componentId: string;
  name: string;
  kind: ComponentKind;
  provider: ProviderId;
  runtime: "available" | "not_deployed" | "unsupported";
  runtimeNote: string | null;
  deployments: LogsIndexDeployment[];
};

/** The Logs page: one tab per component, each with only its own deployments. */
export type LogsIndex = {
  projectId: string;
  components: LogsIndexComponent[];
  docker: { deployments: LogsIndexDeployment[]; runtime: "available" | "not_running" } | null;
};

export type RuntimeSince = "5m" | "15m" | "1h";

// ---------------------------------------------------------- AI (Phase 13) --

export type AiVerdict = "healthy" | "degraded" | "failing" | "unknown";
export type AiStepWhere = "configure" | "settings" | "environment" | "repository" | "provider_dashboard" | "redeploy";

export type AnalysisResult = {
  verdict: AiVerdict;
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
    where: AiStepWhere;
    componentId: string | null;
    command: string | null;
    file: string | null;
    envKey: string | null;
  }>;
  components: Array<{ componentId: string; status: "ok" | "warning" | "failing" | "unknown"; note: string }>;
  providerNotes: string | null;
  followUps: string[];
};

/** One AI analysis: of the whole project, or of one component ("docker" = the local Docker deploys). */
export type AnalysisView = {
  id: string;
  projectId: string;
  scope: "project" | "component";
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
};

export type AnalysisSummary = {
  id: string;
  scope: "project" | "component";
  componentId: string | null;
  deploymentId: string | null;
  question: string | null;
  engine: "openai" | "rules";
  verdict: AiVerdict | null;
  summary: string | null;
  createdAt: string;
  helpful: boolean | null;
};
