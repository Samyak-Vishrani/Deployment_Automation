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
  | { kind: "github"; action: string };

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

export const isFinished = (status: DeploymentStatus) =>
  status === "success" || status === "failed" || status === "cancelled";

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
