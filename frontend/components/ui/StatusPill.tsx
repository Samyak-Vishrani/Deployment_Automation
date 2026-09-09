import type { ReactNode } from "react";
import type { DeploymentStatus, HealthStatus, RunStatus, StageStatus } from "@/lib/platform/types";

type StatusValue = RunStatus | StageStatus | DeploymentStatus | HealthStatus | "healthy" | "degraded" | "offline" | "connected" | "configured";

const labels: Record<StatusValue, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
  pending: "Pending",
  skipped: "Skipped",
  deploying: "Deploying",
  healthy: "Healthy",
  "rolled-back": "Rolled back",
  passing: "Passing",
  warning: "Warning",
  failing: "Failing",
  degraded: "Degraded",
  offline: "Not deployed",
  connected: "Connected",
  configured: "Configured",
};

const tone: Record<StatusValue, string> = {
  queued: "neutral",
  running: "blue",
  succeeded: "green",
  failed: "red",
  canceled: "neutral",
  pending: "neutral",
  skipped: "neutral",
  deploying: "blue",
  healthy: "green",
  "rolled-back": "amber",
  passing: "green",
  warning: "amber",
  failing: "red",
  degraded: "amber",
  offline: "neutral",
  connected: "green",
  configured: "blue",
};

export function StatusPill({ status, children }: { status: StatusValue; children?: ReactNode }) {
  return (
    <span className={`status-pill status-${tone[status]}`}>
      <span className="status-dot" />
      {children ?? labels[status]}
    </span>
  );
}
