import { HttpError } from "@/lib/api/http-error";
import {
  IntegrationServiceClient,
  type IntegrationServiceConfig,
  type IntegrationServiceInfo,
} from "@/lib/providers/integration-service.client";
import type { LogPhase, LogSource, LogStream, LogsReadResult } from "./log-types";

/**
 * Typed client for the logs service (backend/logs, :3005; Phase 12). It has
 * its own shared token, LOGS_SERVICE_TOKEN. The service stores every build
 * log and tails runtime logs; this backend checks ownership first and passes
 * the ids it has verified.
 */

export const LOGS_SERVICE_UNAVAILABLE = "logs_service_unavailable";

const INFO: IntegrationServiceInfo = {
  label: "Logs",
  folder: "backend/logs",
  unavailableCode: LOGS_SERVICE_UNAVAILABLE,
  tokenVar: "LOGS_SERVICE_TOKEN",
};

export function loadLogsServiceConfig(env: NodeJS.ProcessEnv = process.env): IntegrationServiceConfig {
  return {
    baseUrl: (env.LOGS_SERVICE_URL?.trim() || "http://127.0.0.1:3005").replace(/\/+$/, ""),
    token: env.LOGS_SERVICE_TOKEN?.trim() ?? "",
  };
}

export interface AppendBatch {
  projectId: string;
  componentId: string | null;
  provider: string;
  /** The sender's number for the batch's first entry; a retried batch is dropped by the service. */
  clientSeq: number;
  entries: Array<{ text: string; at: number; source: LogSource; phase: LogPhase; stream: LogStream }>;
}

export interface RuntimeStreamOptions {
  since: "5m" | "15m" | "1h";
  requests?: boolean;
}

const enc = encodeURIComponent;

export class LogsServiceClient extends IntegrationServiceClient {
  constructor(loadConfig: () => IntegrationServiceConfig = loadLogsServiceConfig, timeoutMs = 15_000) {
    super(INFO, loadConfig, timeoutMs);
  }

  override unavailable(detail?: string): HttpError {
    return new HttpError(
      `The logs service is not running. Start it with \`npm run dev\` in backend/logs${detail ? ` (${detail})` : ""}.`,
      503,
      LOGS_SERVICE_UNAVAILABLE,
    );
  }

  // ----------------------------------------------------------- build logs --

  append(deploymentId: string, batch: AppendBatch): Promise<{ nextSeq: number; accepted: number }> {
    return this.call("POST", `/deployments/${enc(deploymentId)}/entries`, batch);
  }

  close(deploymentId: string, projectId: string, status: string): Promise<{ tail: string }> {
    return this.call("POST", `/deployments/${enc(deploymentId)}/close`, { projectId, status });
  }

  entries(deploymentId: string, projectId: string, options: { afterSeq?: number; limit?: number } = {}): Promise<LogsReadResult> {
    const query = new URLSearchParams({ projectId, afterSeq: String(options.afterSeq ?? 0), limit: String(options.limit ?? 5000) });
    return this.call("GET", `/deployments/${enc(deploymentId)}/entries?${query}`);
  }

  async text(deploymentId: string, projectId: string): Promise<string> {
    const response = await this.openStream(`/deployments/${enc(deploymentId)}/text?projectId=${enc(projectId)}`, AbortSignal.timeout(60_000));
    return response.text();
  }

  /** NDJSON BuildStreamEvents, replayed from `afterSeq` then live. */
  openBuildStream(deploymentId: string, projectId: string, afterSeq: number, signal: AbortSignal): Promise<Response> {
    return this.openStream(`/deployments/${enc(deploymentId)}/stream?projectId=${enc(projectId)}&afterSeq=${afterSeq}`, signal);
  }

  // --------------------------------------------------------- runtime logs --

  /** NDJSON RuntimeLogEvents of one Vercel or Render component; the session id is in `x-session-id`. */
  openRuntime(
    userId: string,
    componentId: string,
    provider: "vercel" | "render",
    options: RuntimeStreamOptions,
    signal: AbortSignal,
  ): Promise<Response> {
    const query = new URLSearchParams({ userId, provider, since: options.since, requests: options.requests ? "1" : "0" });
    return this.openStream(`/runtime/components/${enc(componentId)}/stream?${query}`, signal);
  }

  /** The same, for the project's local Docker container. */
  openDockerRuntime(userId: string, containerName: string, options: RuntimeStreamOptions, signal: AbortSignal): Promise<Response> {
    const query = new URLSearchParams({ userId, since: options.since });
    return this.openStream(`/runtime/docker/${enc(containerName)}/stream?${query}`, signal);
  }

  ping(sessionId: string): Promise<{ ok: true }> {
    return this.call("POST", `/runtime/sessions/${enc(sessionId)}/ping`, {});
  }
}
