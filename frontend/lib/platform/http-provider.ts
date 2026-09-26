import { fetchSession, signOut } from "@/lib/api/auth";
import type {
  AiInsight,
  Deployment,
  HealthCheck,
  LogEntry,
  PipelineRun,
  PlatformProvider,
  Project,
  ProjectInput,
  SimulationMode,
} from "./types";

export class PlatformApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new PlatformApiError(body?.message ?? "The platform API returned an error.", response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export class HttpPlatformProvider implements PlatformProvider {
  logout() {
    return signOut();
  }

  getSession() {
    return fetchSession();
  }

  listProjects() {
    return request<Project[]>("/projects");
  }

  createProject(input: ProjectInput) {
    return request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getProject(projectId: string) {
    return request<Project>(`/projects/${projectId}`);
  }

  listPipelineRuns(projectId: string) {
    return request<PipelineRun[]>(`/projects/${projectId}/pipeline-runs`);
  }

  getPipelineRun(runId: string) {
    return request<PipelineRun>(`/pipeline-runs/${runId}`);
  }

  triggerPipeline(projectId: string, simulation: SimulationMode = "success") {
    return request<PipelineRun>(`/projects/${projectId}/pipeline-runs`, {
      method: "POST",
      body: JSON.stringify({ simulation }),
    });
  }

  cancelPipeline(runId: string) {
    return request<PipelineRun>(`/pipeline-runs/${runId}/cancel`, { method: "POST" });
  }

  redeploy(deploymentId: string) {
    return request<Deployment>(`/deployments/${deploymentId}/redeploy`, { method: "POST" });
  }

  listDeployments(projectId: string) {
    return request<Deployment[]>(`/projects/${projectId}/deployments`);
  }

  getDeploymentLogs(deploymentId: string) {
    return request<LogEntry[]>(`/deployments/${deploymentId}/logs`);
  }

  getPipelineLogs(runId: string) {
    return request<LogEntry[]>(`/pipeline-runs/${runId}/logs`);
  }

  getHealthChecks(projectId: string) {
    return request<HealthCheck[]>(`/projects/${projectId}/health`);
  }

  getAiInsights(projectId: string) {
    return request<AiInsight[]>(`/projects/${projectId}/ai-insights`);
  }
}
