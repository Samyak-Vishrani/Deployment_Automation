import type { AiStepWhere, AiVerdict, AnalysisResult } from "./types";

/** Phase 13: display helpers for an AI analysis (kept pure so they are testable). */

export const VERDICT_LABEL: Record<AiVerdict, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failing: "Failing",
  unknown: "Unknown",
};

export const WHERE_LABEL: Record<AiStepWhere, string> = {
  configure: "Configure",
  environment: "Environment",
  settings: "Settings",
  repository: "Repository",
  provider_dashboard: "Provider dashboard",
  redeploy: "Redeploy",
};

/** The Logs page, on the evidence's component tab and deployment ("docker" is a tab too). */
export function evidenceHref(projectId: string, componentId: string | null, deploymentId: string | null): string {
  const params = new URLSearchParams();
  if (componentId) params.set("c", componentId);
  if (deploymentId) params.set("d", deploymentId);
  const query = params.toString();
  return `/deploy/${encodeURIComponent(projectId)}/logs${query ? `?${query}` : ""}`;
}

/** Where in OrbitOps a fix step is done, or null when it is outside (the repo, a provider dashboard). */
export function stepHref(projectId: string, where: AiStepWhere): string | null {
  switch (where) {
    case "configure":
    case "environment":
      return `/deploy/${encodeURIComponent(projectId)}/configure`;
    case "settings":
      return "/settings";
    case "redeploy":
      return `/deploy/${encodeURIComponent(projectId)}`;
    default:
      return null;
  }
}

/** The verdict to show: a result whose verdict is not one we know reads as unknown. */
export function verdictOf(result: Pick<AnalysisResult, "verdict">): AiVerdict {
  return result.verdict in VERDICT_LABEL ? result.verdict : "unknown";
}
