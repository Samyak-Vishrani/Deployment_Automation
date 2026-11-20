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
  EnvironmentView,
  EnvPutEntry,
  EnvSuggestions,
  LogsIndex,
  PreflightResult,
  RuntimeSince,
  ConnectableProvider,
  ProjectAnalysis,
  ProviderCredential,
  Release,
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

/** Validates the token (Vercel) or API key (Render, Neon) with the provider, then stores it encrypted. */
export const saveProviderToken = (provider: ConnectableProvider, token: string) =>
  api.put<ProviderCredential>(`/api/providers/${provider}/credential`, { token }, withSession);

/** Vercel: the team new projects are created in (null = personal scope). */
export const setProviderTeam = (provider: "vercel", teamId: string | null) =>
  api.patch<ProviderCredential>(`/api/providers/${provider}/credential`, { teamId }, withSession);

/**
 * Render: the workspace, and the region and plan new services are created with.
 * Neon: the organization, and the region and Postgres version new databases are created with.
 */
export function setProviderPreferences(
  provider: "render",
  prefs: { ownerId?: string; region?: string; plan?: string },
): Promise<ProviderCredential>;
export function setProviderPreferences(
  provider: "neon",
  prefs: { orgId?: string | null; regionId?: string; pgVersion?: number },
): Promise<ProviderCredential>;
export function setProviderPreferences(provider: "render" | "neon", prefs: Record<string, unknown>): Promise<ProviderCredential> {
  return api.patch<ProviderCredential>(`/api/providers/${provider}/credential`, prefs, withSession);
}

/**
 * "Deploy all" (Phase 8): the Neon database, then the Render backend, then the
 * Vercel frontend, at the branch head. 409 while one runs; 412 when pre-flight fails.
 */
export const deployAll = (projectId: string) =>
  api.post<Release>(`/api/projects/${encodeURIComponent(projectId)}/releases`, undefined, withSession);

export const listReleases = (projectId: string, take = 5) =>
  api.get<Release[]>(`/api/projects/${encodeURIComponent(projectId)}/releases?take=${take}`, withSession);

export const getRelease = (releaseId: string) =>
  api.get<Release>(`/api/releases/${encodeURIComponent(releaseId)}`, withSession);

export const cancelRelease = (releaseId: string) =>
  api.post<Release>(`/api/releases/${encodeURIComponent(releaseId)}/cancel`, undefined, withSession);

/** Every scope's env vars: keys and flags only, never a value (Phase 9). */
export const getEnvironment = (projectId: string) =>
  api.get<EnvironmentView>(`/api/projects/${encodeURIComponent(projectId)}/env`, withSession);

/** Replaces the shared set (every backend + local Docker). A value left out keeps the stored one. */
export const putSharedEnv = (projectId: string, vars: EnvPutEntry[]) =>
  api.put<EnvironmentView>(`/api/projects/${encodeURIComponent(projectId)}/env`, { vars }, withSession);

/** Replaces one component's own set. A value left out keeps the stored one. */
export const putComponentEnv = (projectId: string, componentId: string, vars: EnvPutEntry[]) =>
  api.put<EnvironmentView>(
    `/api/projects/${encodeURIComponent(projectId)}/components/${encodeURIComponent(componentId)}/env`,
    { vars },
    withSession,
  );

/** The value of a NON-secret variable; 403 env_secret for a secret. componentId null = shared. */
export const revealEnv = (projectId: string, componentId: string | null, key: string) =>
  api.get<{ key: string; value: string }>(
    componentId
      ? `/api/projects/${encodeURIComponent(projectId)}/components/${encodeURIComponent(componentId)}/env/${encodeURIComponent(key)}`
      : `/api/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(key)}`,
    { ...withSession, cache: "no-store" },
  );

/** Keys from the component's .env.example at the branch head. */
export const envSuggestions = (projectId: string, componentId: string) =>
  api.get<EnvSuggestions>(
    `/api/projects/${encodeURIComponent(projectId)}/components/${encodeURIComponent(componentId)}/env/suggestions`,
    withSession,
  );

export const disconnectProvider = (provider: ConnectableProvider) =>
  api.delete<{ deleted: boolean }>(`/api/providers/${provider}/credential`, withSession);

/** Repositories the user can connect, read live from GitHub with their own token. */
export const listRepositories = () => api.get<RepositoryList>("/api/repositories", withSession);

export const listBranches = (owner: string, repo: string) =>
  api.get<BranchList>(
    `/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    withSession,
  );

/** The Logs page index: per component, its own deployments and whether runtime logs exist (Phase 12). */
export const getLogsIndex = (projectId: string) =>
  api.get<LogsIndex>(`/api/projects/${encodeURIComponent(projectId)}/logs`, withSession);

/** One deployment's build log as a .log file. */
export const logDownloadUrl = (deploymentId: string) => streamUrl(`/api/deployments/${encodeURIComponent(deploymentId)}/logs/download`);

/** SSE of one component's live runtime logs; `componentId` null = the project's local Docker container. */
export function runtimeLogsUrl(projectId: string, componentId: string | null, options: { since: RuntimeSince; requests?: boolean }): string {
  const query = new URLSearchParams({ since: options.since, requests: options.requests ? "1" : "0" });
  const base = componentId
    ? `/api/projects/${encodeURIComponent(projectId)}/components/${encodeURIComponent(componentId)}/runtime-logs/stream`
    : `/api/projects/${encodeURIComponent(projectId)}/runtime-logs/stream`;
  return streamUrl(`${base}?${query}`);
}

/** Keeps a runtime stream alive while the tab is visible. */
export const pingRuntimeLogs = (projectId: string, sessionId: string) =>
  api.post<{ ok: true }>(
    `/api/projects/${encodeURIComponent(projectId)}/runtime-logs/${encodeURIComponent(sessionId)}/ping`,
    undefined,
    withSession,
  );

/** Absolute URL for an EventSource, which cannot use the api client's fetch. */
export function streamUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}
