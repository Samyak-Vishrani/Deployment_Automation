import type { DeploymentLogsService, DeploymentLogWriter } from "@/lib/deployments/deployment-logs.service";

const TAIL_BYTES = 64 * 1024;

/**
 * Writes provider build output into the same per-deployment log file the local
 * Docker builds use, so /logs, /logs/stream and the build page work unchanged.
 *
 * Lines arrive in batches over minutes, from callbacks, so one writer is kept
 * open per active deployment rather than reopened per batch. The writer
 * appends, so a backend restart mid-build just opens a new one on the same
 * file.
 */
export class ProviderLogSink {
  private readonly writers = new Map<string, DeploymentLogWriter>();

  constructor(private readonly logs: DeploymentLogsService) {}

  async write(projectId: string, deploymentId: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const writer = await this.writer(projectId, deploymentId);
    for (const line of lines) writer.write(line);
  }

  async section(projectId: string, deploymentId: string, title: string): Promise<void> {
    (await this.writer(projectId, deploymentId)).section(title);
  }

  /**
   * Ends the stream (the build page's EventSource gets "done") and returns the
   * last 64 KB of the whole log for Deployment.logTail. Read from the file, not
   * the writer's memory, which only holds lines written since this process
   * started.
   */
  async close(projectId: string, deploymentId: string, status: string): Promise<string> {
    const writer = await this.writer(projectId, deploymentId);
    this.writers.delete(deploymentId);
    await writer.close(status);
    const text = await this.logs.read(projectId, deploymentId).catch(() => writer.tailText());
    return text.length > TAIL_BYTES ? text.slice(text.length - TAIL_BYTES) : text;
  }

  private async writer(projectId: string, deploymentId: string): Promise<DeploymentLogWriter> {
    let writer = this.writers.get(deploymentId);
    if (!writer) {
      writer = await this.logs.open(projectId, deploymentId);
      this.writers.set(deploymentId, writer);
    }
    return writer;
  }
}
