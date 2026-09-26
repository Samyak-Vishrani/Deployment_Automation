import { api } from "@/lib/api";
import { getApiBaseUrl } from "@/lib/api/config";
import type { CreateDeployProjectInput, DeployProject, DeployRun } from "./types";

/**
 * The session cookie is httpOnly and set by the backend on a different origin
 * (:3001 vs :3000), so every deploy call has to opt into sending it. The shared
 * api client deliberately does not default to this - most of its callers are
 * public reads.
 */
const withSession: RequestInit = { credentials: "include" };

export const listDeployProjects = () => api.get<DeployProject[]>("/api/projects", withSession);

export const getDeployProject = (id: string) =>
  api.get<DeployProject>(`/api/projects/${id}`, withSession);

export const createDeployProject = (input: CreateDeployProjectInput) =>
  api.post<DeployProject>("/api/projects", input, withSession);

export const deleteDeployProject = (id: string) =>
  api.delete<{ deleted: true; id: string }>(`/api/projects/${id}`, withSession);

export const deployProject = (id: string) =>
  api.post<DeployRun>(`/api/projects/${id}/deploy`, undefined, withSession);

export const rollbackProject = (id: string) =>
  api.post<DeployRun>(`/api/projects/${id}/rollback`, undefined, withSession);

export const listDeployRuns = (projectId: string) =>
  api.get<DeployRun[]>(`/api/projects/${projectId}/deployments`, withSession);

export const getDeployRun = (id: string) =>
  api.get<DeployRun>(`/api/deployments/${id}`, withSession);

export const cancelDeployRun = (id: string) =>
  api.post<{ status: string }>(`/api/deployments/${id}/cancel`, undefined, withSession);

/** Absolute URL for an EventSource, which cannot use the api client's fetch. */
export function streamUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}
