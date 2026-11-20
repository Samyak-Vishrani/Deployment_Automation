import type { LogPhase, LogSource, LogStream } from "@/lib/logs/log-types";
import type { RemoteLogWriter } from "@/lib/logs/remote-log-writer";
import type { RemoteLogs } from "@/lib/logs/remote-logs";

/** A line with its tags; a plain string is one of OrbitOps' own lines. */
export type SinkLine = string | { text: string; at?: number; stream?: LogStream; phase?: LogPhase; source?: LogSource };

/** Which component and provider a deployment belongs to, so its log is filed with them. */
export type DeploymentLookup = (deploymentId: string) => Promise<{ componentId: string | null; provider: string } | null>;

/**
 * Writes provider deploys' logs to the logs service (backend/logs, Phase 12),
 * the same per-deployment store the local Docker builds use, so the build
 * page and the Logs page work the same for every provider.
 *
 * Lines arrive in batches over minutes, from callbacks, so one writer is kept
 * per active deployment. A backend restart mid-build just opens a new one:
 * the logs service appends to the same log.
 */
export class ProviderLogSink {
  private readonly writers = new Map<string, RemoteLogWriter>();

  constructor(
    private readonly logs: Pick<RemoteLogs, "open">,
    private readonly describe: DeploymentLookup = async () => null,
  ) {}

  /** Plain strings are OrbitOps' own lines; tagged lines keep their source, stream, phase and time. */
  async write(projectId: string, deploymentId: string, lines: SinkLine[], defaults: { source?: LogSource; phase?: LogPhase } = {}): Promise<void> {
    if (lines.length === 0) return;
    const writer = await this.writer(projectId, deploymentId);
    for (const line of lines) {
      if (typeof line === "string") {
        writer.write(line, { source: defaults.source ?? "orbitops", phase: defaults.phase ?? "deploy", stream: "info" });
      } else {
        writer.write(line.text, {
          source: line.source ?? defaults.source ?? "orbitops",
          phase: line.phase ?? defaults.phase,
          stream: line.stream,
          at: line.at,
        });
      }
    }
  }

  /**
   * Values to scrub from every line written from here on (Phase 9: the env
   * var secrets and connection strings a deploy is sent with). A backstop:
   * no code writes a value on purpose, and the integration services redact
   * the provider logs they relay.
   */
  async addSecrets(projectId: string, deploymentId: string, values: (string | null | undefined)[]): Promise<void> {
    const writer = await this.writer(projectId, deploymentId);
    for (const value of values) writer.addSecret(value);
  }

  async section(projectId: string, deploymentId: string, title: string, meta: { source?: LogSource; phase?: LogPhase } = {}): Promise<void> {
    (await this.writer(projectId, deploymentId)).section(title, { phase: "deploy", ...meta });
  }

  /**
   * Ends the log (the build page's stream gets "done") and returns its last
   * 64 KB for Deployment.logTail: the logs service's, or this process's own
   * copy when the service cannot be reached.
   */
  async close(projectId: string, deploymentId: string, status: string): Promise<string> {
    const writer = await this.writer(projectId, deploymentId);
    this.writers.delete(deploymentId);
    return writer.close(status);
  }

  private async writer(projectId: string, deploymentId: string): Promise<RemoteLogWriter> {
    let writer = this.writers.get(deploymentId);
    if (!writer) {
      const info = await this.describe(deploymentId).catch(() => null);
      writer = this.logs.open(projectId, deploymentId, {
        componentId: info?.componentId ?? null,
        provider: info?.provider ?? "unknown",
        defaultSource: "orbitops",
      });
      this.writers.set(deploymentId, writer);
    }
    return writer;
  }
}
