// Copied from backend/vercel_integration/src/deployments/deploy-queue.ts. Each integration service builds and
// deploys on its own, so shared plumbing is copied, not imported. Keep the copies in step.

/**
 * In-memory deploy queue: FIFO per component, with a global concurrency cap.
 *
 * The same idea as backend/lib/deployments/deployment-queue.ts. Two deploys of
 * one component never run at once (they would race on the same Render
 * project), different components run in parallel. A running job mostly sleeps
 * between status polls, so the cap can be generous.
 *
 * Durability comes from Postgres, not from here: every job is a
 * RenderDeployment row before it is queued, and startup re-queues what is not
 * finished.
 */

export interface DeployJob {
  deploymentId: string;
  componentId: string;
}

/** Why a running job was aborted. A shutdown must NOT cancel the deploy on Render. */
export type AbortReason = "cancel" | "shutdown";

export type DeployJobRunner = (job: DeployJob, signal: AbortSignal) => Promise<void>;

interface QueuedJob extends DeployJob {
  controller: AbortController;
}

export class DeployQueue {
  private waiting: QueuedJob[] = [];
  private readonly busyComponents = new Set<string>();
  private readonly inflight = new Map<string, QueuedJob>();
  private draining = false;
  private runner: DeployJobRunner | null = null;

  constructor(private readonly concurrency = 8) {}

  setRunner(runner: DeployJobRunner): void {
    this.runner = runner;
    queueMicrotask(() => this.schedule());
  }

  add(job: DeployJob): boolean {
    if (this.draining || this.has(job.deploymentId)) return false;
    this.waiting.push({ ...job, controller: new AbortController() });
    queueMicrotask(() => this.schedule());
    return true;
  }

  has(deploymentId: string): boolean {
    return this.inflight.has(deploymentId) || this.waiting.some((j) => j.deploymentId === deploymentId);
  }

  /** "aborted": it was running and has been told to stop. "removed": it never started. */
  cancel(deploymentId: string): "aborted" | "removed" | "not-found" {
    const running = this.inflight.get(deploymentId);
    if (running) {
      running.controller.abort("cancel" satisfies AbortReason);
      return "aborted";
    }
    const index = this.waiting.findIndex((j) => j.deploymentId === deploymentId);
    if (index !== -1) {
      this.waiting.splice(index, 1);
      return "removed";
    }
    return "not-found";
  }

  get stats(): { waiting: number; running: number; concurrency: number } {
    return { waiting: this.waiting.length, running: this.inflight.size, concurrency: this.concurrency };
  }

  private schedule(): void {
    if (this.draining || !this.runner) return;
    while (this.inflight.size < this.concurrency) {
      const index = this.waiting.findIndex((j) => !this.busyComponents.has(j.componentId));
      if (index === -1) return;
      const [job] = this.waiting.splice(index, 1);
      this.busyComponents.add(job.componentId);
      this.inflight.set(job.deploymentId, job);

      void this.runner({ deploymentId: job.deploymentId, componentId: job.componentId }, job.controller.signal)
        .catch((error: Error) => console.error(`[queue] Deployment ${job.deploymentId} crashed: ${error.message}`))
        .finally(() => {
          this.busyComponents.delete(job.componentId);
          this.inflight.delete(job.deploymentId);
          this.schedule();
        });
    }
  }

  /**
   * Stops taking work and aborts running jobs with reason "shutdown", so they
   * stop polling but leave the deploy on Render alone; the next start resumes
   * them. Waits up to `timeoutMs` for them to wind down.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    this.draining = true;
    this.waiting = [];
    for (const job of this.inflight.values()) job.controller.abort("shutdown" satisfies AbortReason);
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
