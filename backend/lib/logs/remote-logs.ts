import type { LogsServiceClient } from "./logs-service.client";
import type { LogSource, LogsReadResult } from "./log-types";
import { RemoteLogWriter, type WriterOptions } from "./remote-log-writer";

export interface OpenOptions extends Pick<WriterOptions, "secrets"> {
  componentId?: string | null;
  provider: string;
  defaultSource?: LogSource;
}

/**
 * Build logs, kept by the logs service (backend/logs) since Phase 12. It
 * replaces the old DeploymentLogsService, which wrote files in this process:
 * the main backend now keeps no log files at all.
 */
export class RemoteLogs {
  constructor(
    private readonly client: Pick<LogsServiceClient, "append" | "close" | "entries" | "text" | "openBuildStream">,
    private readonly writerOptions: Omit<WriterOptions, "secrets" | "defaultSource"> = {},
  ) {}

  open(projectId: string, deploymentId: string, options: OpenOptions): RemoteLogWriter {
    return new RemoteLogWriter(
      this.client,
      { deploymentId, projectId, componentId: options.componentId ?? null, provider: options.provider },
      { ...this.writerOptions, secrets: options.secrets, defaultSource: options.defaultSource },
    );
  }

  /** The whole log as text. */
  read(projectId: string, deploymentId: string): Promise<string> {
    return this.client.text(deploymentId, projectId);
  }

  entries(projectId: string, deploymentId: string, options: { afterSeq?: number; limit?: number } = {}): Promise<LogsReadResult> {
    return this.client.entries(deploymentId, projectId, options);
  }

  openStream(projectId: string, deploymentId: string, afterSeq: number, signal: AbortSignal): Promise<Response> {
    return this.client.openBuildStream(deploymentId, projectId, afterSeq, signal);
  }
}
