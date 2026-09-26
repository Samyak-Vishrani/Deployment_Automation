export interface QueueJob {
  deploymentId: string;
  projectId: string;
}

interface InternalJob extends QueueJob {
  /** Group key. Jobs sharing one never run concurrently. */
  groupKey: string;
  controller: AbortController;
}

export type JobRunner = (job: QueueJob, signal: AbortSignal) => Promise<void>;

/**
 * In-memory deployment queue: per-project FIFO, with a global concurrency cap.
 *
 * Not BullMQ, and not Redis. The decisive argument is that Postgres is already
 * the durable queue - every job exists as a Deployment row with status 'queued'
 * BEFORE it is enqueued here, so a crash loses only scheduler state, which one
 * startup query rebuilds. And the work is inherently pinned to this machine: it
 * needs this Docker socket, this filesystem and this host port, so a
 * Redis-backed queue's one real advantage - any worker can take any job - is
 * unusable. Dokploy reached the same conclusion and removed BullMQ.
 *
 * The per-project serialisation is the important invariant. Two pushes to one
 * project must never build at once: they would fight over the same workspace,
 * the same image tag and the same container name, and only one can hold the
 * host port. Different projects run in parallel freely.
 */
export class DeploymentQueue {
  private waiting: InternalJob[] = [];
  private activeGroups = new Set<string>();
  private inflight = new Map<string, InternalJob>();
  private draining = false;
  private runner: JobRunner | null = null;

  private readonly concurrency = Math.max(1, Number(process.env.DEPLOY_CONCURRENCY ?? 2));

  setRunner(runner: JobRunner): void {
    this.runner = runner;
  }

  get stats(): { waiting: number; active: number; concurrency: number } {
    return {
      waiting: this.waiting.length,
      active: this.inflight.size,
      concurrency: this.concurrency,
    };
  }

  /** Synchronous by design: nothing on the webhook path may await a build. */
  add(job: QueueJob): void {
    if (this.draining) {
      console.warn(`[queue] Shutting down; refusing deployment ${job.deploymentId}.`);
      return;
    }
    this.waiting.push({
      ...job,
      groupKey: `project:${job.projectId}`,
      controller: new AbortController(),
    });
    queueMicrotask(() => this.schedule());
  }

  /** Cancels a job whether it is queued or already running. */
  cancel(deploymentId: string): "cancelled" | "not-found" {
    const running = this.inflight.get(deploymentId);
    if (running) {
      running.controller.abort();
      return "cancelled";
    }
    const index = this.waiting.findIndex((j) => j.deploymentId === deploymentId);
    if (index !== -1) {
      this.waiting.splice(index, 1);
      return "cancelled";
    }
    return "not-found";
  }

  isQueuedOrRunning(deploymentId: string): boolean {
    return (
      this.inflight.has(deploymentId) ||
      this.waiting.some((j) => j.deploymentId === deploymentId)
    );
  }

  private schedule(): void {
    if (this.draining || !this.runner) {
      return;
    }

    while (this.inflight.size < this.concurrency) {
      // The first waiting job whose group is idle. Scanning rather than taking
      // the head is what makes this per-group FIFO instead of a single queue:
      // a busy project must not block every other project behind it.
      const index = this.waiting.findIndex((job) => !this.activeGroups.has(job.groupKey));
      if (index === -1) {
        return;
      }

      const [job] = this.waiting.splice(index, 1);
      this.activeGroups.add(job.groupKey);
      this.inflight.set(job.deploymentId, job);

      void this.runner(job, job.controller.signal)
        .catch((error: Error) =>
          console.error(`[queue] Deployment ${job.deploymentId} failed: ${error.message}`),
        )
        .finally(() => {
          this.activeGroups.delete(job.groupKey);
          this.inflight.delete(job.deploymentId);
          this.schedule(); // re-tick: a slot and a group just freed up
        });
    }
  }

  /**
   * Stops accepting work and waits for in-flight jobs, aborting them first.
   * Returns the ids that were still running, so they can be marked cancelled.
   */
  async drain(timeoutMs = 10_000): Promise<string[]> {
    this.draining = true;
    const dropped = this.waiting.splice(0).map((j) => j.deploymentId);
    const running = [...this.inflight.keys()];

    for (const job of this.inflight.values()) {
      job.controller.abort();
    }

    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 100));
    }

    return [...dropped, ...running];
  }
}
