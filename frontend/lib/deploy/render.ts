import { api } from "@/lib/api";
import type { DeployComponent } from "./types";
const session = { credentials: "include" as const };
export type RenderConnection = { connected: boolean; ownerId?: string; ownerName?: string };
export type RenderConfig = { runtime: string; region: string; plan: string; healthCheckPath: string; serviceId: string | null; url: string | null; envKeys: string[] };
export type RenderAnalysis = { analysis: { summary: string; rootCause: string; severity: string; confidence: number; evidence: string[]; recommendations: { title: string; description: string; command?: string; file?: string }[] } };
export type RenderRun = { id: string; componentId: string; status: string; error: string | null; logs: string; logWarning: string | null; analysis: RenderAnalysis | null; analysisError: string | null; createdAt: string; finishedAt: string | null };
export type RenderView = { connection: RenderConnection; aiAvailable: boolean; components: (DeployComponent & { config: RenderConfig | null })[]; deployments: RenderRun[] };
export const getRender = (projectId: string) => api.get<RenderView>(`/api/projects/${projectId}/render`, session);
export const renderWorkspaces = (apiKey: string) => api.post<{ owners: { id: string; name: string }[] }>("/api/render/connection", { action: "workspaces", apiKey }, session);
export const connectRender = (apiKey: string, ownerId: string) => api.post<RenderConnection>("/api/render/connection", { apiKey, ownerId }, session);
export const disconnectRender = () => api.delete<RenderConnection>("/api/render/connection", session);
export const saveRender = (projectId: string, settings: Record<string, unknown>) => api.put<RenderView>(`/api/projects/${projectId}/render`, settings, session);
export const renderAction = (projectId: string, action: string, input: Record<string, unknown>) => api.post<RenderRun>(`/api/projects/${projectId}/render`, { action, ...input }, session);
export const analyzeRender = (projectId: string, deploymentId: string) => api.post<RenderAnalysis>("/api/log-analysis/analyze", { projectId, deploymentId }, session);
export const isActiveRender = (status: string) => ["submitting", "deploying", "uncertain"].includes(status);

export function parseEnvText(value: string): Record<string, string> {
  const entries = value.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith("#")).map(line => {
    const split = line.indexOf("=");
    if (split < 1) throw new Error("Use KEY=value on each environment variable line.");
    const key = line.slice(0, split).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid environment variable name.");
    return [key, line.slice(split + 1)] as const;
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Environment variable names must be unique.");
  return Object.fromEntries(entries);
}
