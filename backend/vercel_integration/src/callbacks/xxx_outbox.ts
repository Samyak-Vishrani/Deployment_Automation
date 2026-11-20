import type { Prisma } from "@prisma/client";
import type { Db } from "../db";
import { abortableSleep } from "../http/provider-fetch";
import type { EventBatch, ProviderEvent } from "../types";
import type { CallbackSender } from "./callback-client";

export interface OutboxOptions {
  /** How long buffered log lines wait before they are sent. */
  flushIntervalMs?: number;
  /** Log lines that trigger an immediate send. */
  maxLinesPerBatch?: number;
  /** How long one batch is retried before it is left for the next start. */
  giveUpAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Buffer {
  events: ProviderEvent[];
  lines: number;
  timer?: NodeJS.Timeout;
}

/**
 * Ordered, at-least-once delivery of deploy events to the main backend.
 *
 * Each deployment has its own chain: batches are numbered (seq) and sent one
 * after another, so the main backend sees "deploying" before "live" and log
 * lines in order. A batch is written to VercelDeployment.pendingEvents BEFORE
 * it is sent and removed once acknowledged, so a restart re-sends what was not
 * delivered rather than losing it. The main backend discards any seq it has
 * already applied, which makes the re-send harmless.
 */
export class EventOutbox {
  private readonly buffers = new Map<string, Buffer>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly flushIntervalMs: number;
  private readonly maxLines: number;
  private readonly giveUpAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private stopping = false;

  constructor(
    private readonly db: Db,
    private readonly sender: CallbackSender,
    options: OutboxOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.maxLines = options.maxLinesPerBatch ?? 200;
    this.giveUpAfterMs = options.giveUpAfterMs ?? 10 * 60 * 1000;
    this.sleep = options.sleep ?? ((ms) => abortableSleep(ms));
  }

  /**
   * Queues one event. Log lines are batched; anything else (a status change)
   * flushes immediately, together with the lines before it, so order holds.
   */
  push(deploymentId: string, event: ProviderEvent): void {
    const buffer = this.buffers.get(deploymentId) ?? { events: [], lines: 0 };
    this.buffers.set(deploymentId, buffer);

    const last = buffer.events[buffer.events.length - 1];
    if (event.type === "logs" && last?.type === "logs") {
      last.lines.push(...event.lines);
    } else {
      buffer.events.push(event.type === "logs" ? { type: "logs", lines: [...event.lines] } : event);
    }
    if (event.type === "logs") buffer.lines += event.lines.length;

    if (event.type !== "logs" || buffer.lines >= this.maxLines) {
      this.flush(deploymentId);
    } else if (!buffer.timer) {
      buffer.timer = setTimeout(() => this.flush(deploymentId), this.flushIntervalMs);
    }
  }

  /** Sends whatever is buffered for the deployment, after anything already in flight. */
  flush(deploymentId: string): Promise<void> {
    const buffer = this.buffers.get(deploymentId);
    if (buffer?.timer) clearTimeout(buffer.timer);
    this.buffers.delete(deploymentId);
    if (!buffer || buffer.events.length === 0) {
      return this.chains.get(deploymentId) ?? Promise.resolve();
    }
    return this.enqueue(deploymentId, async () => {
      const batch = await this.record(deploymentId, buffer.events);
      if (batch) await this.deliver(batch);
    });
  }

  /** Resolves once every event pushed so far for the deployment has been handled. */
  async drain(deploymentId: string): Promise<void> {
    await this.flush(deploymentId);
  }

  /** On startup: re-send batches a previous process wrote but never got acknowledged. */
  async redeliverPending(): Promise<number> {
    const rows = await this.db.vercelDeployment.findMany({
      where: { NOT: { pendingEvents: { equals: [] } } },
      select: { deploymentId: true, pendingEvents: true },
    });
    let count = 0;
    for (const row of rows) {
      const batches = asBatches(row.pendingEvents).sort((a, b) => a.seq - b.seq);
      for (const batch of batches) {
        count++;
        void this.enqueue(row.deploymentId, () => this.deliver(batch));
      }
    }
    return count;
  }

  /** Stops retry loops (shutdown). Undelivered batches stay persisted for the next start. */
  stop(): void {
    this.stopping = true;
    for (const buffer of this.buffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
  }

  private enqueue(deploymentId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(deploymentId) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error: Error) => console.error(`[outbox] ${deploymentId}: ${error.message}`))
      .finally(() => {
        if (this.chains.get(deploymentId) === next) this.chains.delete(deploymentId);
      });
    this.chains.set(deploymentId, next);
    return next;
  }

  /** Numbers the batch and persists it as pending. Runs inside the deployment's chain. */
  private async record(deploymentId: string, events: ProviderEvent[]): Promise<EventBatch | null> {
    const row = await this.db.vercelDeployment.update({
      where: { deploymentId },
      data: { callbackSeq: { increment: 1 } },
      select: { callbackSeq: true, pendingEvents: true },
    });
    const batch: EventBatch = { deploymentId, seq: row.callbackSeq, events };
    await this.db.vercelDeployment.update({
      where: { deploymentId },
      data: { pendingEvents: [...asBatches(row.pendingEvents), batch] as unknown as Prisma.InputJsonValue },
    });
    return batch;
  }

  private async deliver(batch: EventBatch): Promise<void> {
    const deadline = Date.now() + this.giveUpAfterMs;
    for (let attempt = 1; !this.stopping; attempt++) {
      const result = await this.sender.send(batch);
      if (result === "delivered" || result === "rejected") {
        if (result === "rejected") {
          console.warn(`[outbox] Main backend rejected batch ${batch.seq} of ${batch.deploymentId}; dropping it.`);
        }
        await this.acknowledge(batch);
        return;
      }
      if (Date.now() >= deadline) {
        console.warn(
          `[outbox] Main backend unreachable for ${Math.round(this.giveUpAfterMs / 60000)} min; ` +
            `batch ${batch.seq} of ${batch.deploymentId} stays pending until the next start.`,
        );
        return;
      }
      await this.sleep(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
    }
  }

  private async acknowledge(batch: EventBatch): Promise<void> {
    const row = await this.db.vercelDeployment.findUnique({
      where: { deploymentId: batch.deploymentId },
      select: { pendingEvents: true },
    });
    if (!row) return;
    const remaining = asBatches(row.pendingEvents).filter((b) => b.seq !== batch.seq);
    await this.db.vercelDeployment.update({
      where: { deploymentId: batch.deploymentId },
      data: { pendingEvents: remaining as unknown as Prisma.InputJsonValue },
    });
  }
}

function asBatches(value: unknown): EventBatch[] {
  return Array.isArray(value)
    ? value.filter((b): b is EventBatch => !!b && typeof b === "object" && typeof (b as EventBatch).seq === "number")
    : [];
}
