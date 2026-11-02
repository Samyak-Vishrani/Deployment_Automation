import { api } from "@/lib/api";
import { getApiBaseUrl } from "@/lib/api/config";
import type {
  BranchList,
  ComponentFields,
  ComponentProposal,
  CreateDeployProjectInput,
  DeployComponent,
  DeployProject,
  DeployRun,
  PreflightResult,
  ConnectableProvider,
  ProjectAnalysis,
  ProviderCredential,
  RepositoryList,
} from "./types";

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

/** Analyses the project's branch at its current commit; an unchanged commit returns its snapshot. */
export const analyzeProject = (id: string) =>
  api.post<ProjectAnalysis>(`/api/projects/${id}/analyze`, undefined, withSession);

export const getProjectAnalysis = (id: string) =>
  api.get<ProjectAnalysis>(`/api/projects/${id}/analysis`, withSession);

export const listComponents = (projectId: string) =>
  api.get<DeployComponent[]>(`/api/projects/${projectId}/components`, withSession);

/** Components proposed from the latest analysis (analysing first if needed). Nothing is saved. */
export const getComponentProposal = (projectId: string) =>
  api.get<ComponentProposal>(`/api/projects/${projectId}/components/proposal`, withSession);

/** Replaces the saved set; components matched on kind + folder keep their provider ids. */
export const saveComponents = (projectId: string, components: ComponentFields[]) =>
  api.put<DeployComponent[]>(`/api/projects/${projectId}/components`, { components }, withSession);

export const getPreflight = (projectId: string) =>
  api.get<PreflightResult>(`/api/projects/${projectId}/preflight`, withSession);

/** Deploys one component to its provider (Vercel today) at the branch head. */
export const deployComponent = (projectId: string, componentId: string) =>
  api.post<DeployRun>(`/api/projects/${projectId}/components/${componentId}/deploy`, undefined, withSession);

export const listComponentRuns = (projectId: string, componentId: string) =>
  api.get<DeployRun[]>(`/api/projects/${projectId}/components/${componentId}/deployments`, withSession);

/** Every provider account and its state. Tokens are never returned. */
export const listProviderCredentials = () =>
  api.get<ProviderCredential[]>("/api/providers/credentials", withSession);

/** Validates the token (Vercel) or API key (Render) with the provider, then stores it encrypted. */
export const saveProviderToken = (provider: ConnectableProvider, token: string) =>
  api.put<ProviderCredential>(`/api/providers/${provider}/credential`, { token }, withSession);

/** Vercel: the team new projects are created in (null = personal scope). */
export const setProviderTeam = (provider: "vercel", teamId: string | null) =>
  api.patch<ProviderCredential>(`/api/providers/${provider}/credential`, { teamId }, withSession);

/** Render: the workspace, and the region and plan new services are created with. */
export const setProviderPreferences = (
  provider: "render",
  prefs: { ownerId?: string; region?: string; plan?: string },
) => api.patch<ProviderCredential>(`/api/providers/${provider}/credential`, prefs, withSession);

export const disconnectProvider = (provider: ConnectableProvider) =>
  api.delete<{ deleted: boolean }>(`/api/providers/${provider}/credential`, withSession);

/** Repositories the user can connect, read live from GitHub with their own token. */
export const listRepositories = () => api.get<RepositoryList>("/api/repositories", withSession);

export const listBranches = (owner: string, repo: string) =>
  api.get<BranchList>(
    `/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    withSession,
  );

/** Absolute URL for an EventSource, which cannot use the api client's fetch. */
export function streamUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}
