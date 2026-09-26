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
