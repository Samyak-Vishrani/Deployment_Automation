import { redact } from "@/lib/common/redact";
import type { AppendBatch, LogsServiceClient } from "./logs-service.client";
import { entryToText, type LogPhase, type LogSource, type LogStream, type WriteMeta } from "./log-types";

export interface WriterIds {
  deploymentId: string;
  projectId: string;
  componentId: string | null;
  provider: string;
}

export interface WriterOptions {
  /** Literal secrets scrubbed from every line before it leaves this process. */
  secrets?: (string | null | undefined)[];
  /** The source of a line written without one. */
  defaultSource?: LogSource;
  flushMs?: number;
  batchSize?: number;
  /** Lines held while the logs service is unreachable; the oldest go first beyond this. */
  maxBuffered?: number;
  /** Longest wait between delivery retries. */
  maxRetryMs?: number;
  /** How long `close` waits for the backlog before it falls back to the local tail. */
  closeWaitMs?: number;
  /** How long a closed writer keeps trying to deliver its backlog in the background. */
  backgroundMs?: number;
}

type Queued = AppendBatch["entries"][number] & { clientSeq: number };

const TAIL_LINES = 2000;
const MAX_BATCH = 500;

/**
 * A deployment's build log, written from this backend to the logs service
 * (Phase 12). It keeps DeploymentLogWriter's surface (write, section,
 * addSecret, tailText, close), so the Docker executor and the provider sink
 * barely changed.
 *
 * Lines are redacted here, numbered (`clientSeq`), and sent in batches every
 * `flushMs` or every `batchSize` lines. A failed send is retried with backoff;
 * the service drops anything it already has, so a retry never duplicates.
 * While the service is down, up to `maxBuffered` lines are held; beyond that
 * the oldest are dropped and a "lines lost" line is written once delivery
 * works again. Nothing here can fail a deploy.
 */
export class RemoteLogWriter {
  private secrets: string[] = [];
  private readonly queue: Queued[] = [];
  private readonly tail: string[] = [];
  private nextClientSeq = 1;
  private dropped = 0;
  private timer: NodeJS.Timeout | null = null;
  private sending: Promise<void> | null = null;
  private retryMs: number;
  private failing = false;
  private closedStatus: string | null = null;
  private serviceClosed = false;
  private readonly opts: Required<Omit<WriterOptions, "secrets" | "defaultSource">> & { defaultSource: LogSource };

  constructor(
    private readonly client: Pick<LogsServiceClient, "append" | "close">,
    private readonly ids: WriterIds,
    options: WriterOptions = {},
  ) {
    this.opts = {
      defaultSource: options.defaultSource ?? "orbitops",
      flushMs: options.flushMs ?? 250,
      batchSize: options.batchSize ?? 200,
      maxBuffered: options.maxBuffered ?? 5000,
      maxRetryMs: options.maxRetryMs ?? 30_000,
      closeWaitMs: options.closeWaitMs ?? 5_000,
      backgroundMs: options.backgroundMs ?? 30 * 60_000,
    };
    this.retryMs = this.opts.flushMs;
    for (const secret of options.secrets ?? []) this.addSecret(secret);
  }

  /** Everything written from here on is scrubbed of it (the installation token, env secrets). */
  addSecret(secret: string | undefined | null): void {
    if (secret) this.secrets.push(secret);
  }

  write(text: string, meta: WriteMeta = {}): void {
    const entry: Queued = {
      clientSeq: this.nextClientSeq++,
      text: redact(text, this.secrets),
      at: meta.at && meta.at > 0 ? meta.at : Date.now(),
      source: meta.source ?? this.opts.defaultSource,
      phase: meta.phase ?? defaultPhase(meta.source ?? this.opts.defaultSource),
      stream: meta.stream ?? "stdout",
    };
    this.remember(entry);
    this.queue.push(entry);
    while (this.queue.length > this.opts.maxBuffered) {
      this.queue.shift();
      this.dropped++;
    }
    this.schedule(this.queue.length >= this.opts.batchSize ? 0 : this.opts.flushMs);
  }

  /** A phase marker from OrbitOps itself, so the log reads as one narrative. */
  section(title: string, meta: WriteMeta = {}): void {
    this.write(`==> ${title}`, { source: "orbitops", stream: "info", ...meta });
  }

  /** The last ~64 KB as text, from memory: the fallback for Deployment.logTail. */
  tailText(maxBytes = 64 * 1024): string {
    let out = "";
    for (let i = this.tail.length - 1; i >= 0; i--) {
      const next = this.tail[i] + "\n";
      if (out.length + next.length > maxBytes) break;
      out = next + out;
    }
    return out;
  }

  /** Lines not yet accepted by the logs service. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Delivers what is left and marks the log finished. Returns the logs
   * service's tail, or this writer's own when the service cannot be reached
   * in time; the backlog then keeps trying in the background.
   */
  async close(status: string): Promise<string> {
    this.closedStatus = status;
    const deadline = Date.now() + this.opts.closeWaitMs;
    while (this.queue.length > 0 && Date.now() < deadline) {
      await this.flush();
      if (this.failing) break;
    }
    if (this.queue.length === 0 && !this.failing) {
      try {
        const { tail } = await this.client.close(this.ids.deploymentId, this.ids.projectId, status);
        this.serviceClosed = true;
        this.clearTimer();
        return tail || this.tailText();
      } catch {
        // Falls through to the background retry.
      }
    }
    this.retryInBackground();
    return this.tailText();
  }

  /** Sends one batch now (tests and close call it directly). */
  flush(): Promise<void> {
    if (this.sending) return this.sending;
    if (this.queue.length === 0 && this.dropped === 0) return Promise.resolve();
    this.clearTimer();
    this.sending = this.sendBatch().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  // ------------------------------------------------------------- internals --

  private async sendBatch(): Promise<void> {
    if (this.dropped > 0 && !this.failing) this.noteLost();
    const batch = this.queue.slice(0, MAX_BATCH);
    if (batch.length === 0) return;
    try {
      await this.client.append(this.ids.deploymentId, {
        projectId: this.ids.projectId,
        componentId: this.ids.componentId,
        provider: this.ids.provider,
        clientSeq: batch[0].clientSeq,
        entries: batch.map(({ clientSeq: _seq, ...entry }) => {
          void _seq;
          return entry;
        }),
      });
      this.queue.splice(0, batch.length);
      if (this.failing && this.dropped > 0) this.noteLost();
      this.failing = false;
      this.retryMs = this.opts.flushMs;
      if (this.queue.length > 0) this.schedule(0);
    } catch {
      this.failing = true;
      this.retryMs = Math.min(this.retryMs * 2, this.opts.maxRetryMs);
      this.schedule(this.retryMs);
    }
  }

  /** One line saying how many lines the service never got. */
  private noteLost(): void {
    const lost = this.dropped;
    this.dropped = 0;
    const entry: Queued = {
      clientSeq: this.nextClientSeq++,
      text: `${lost} log line${lost === 1 ? " was" : "s were"} lost while the logs service was unavailable.`,
      at: Date.now(),
      source: "orbitops",
      phase: "deploy",
      stream: "info",
    };
    this.remember(entry);
    this.queue.push(entry);
  }

  private retryInBackground(): void {
    const giveUpAt = Date.now() + this.opts.backgroundMs;
    const attempt = async () => {
      if (this.serviceClosed) return;
      if (Date.now() > giveUpAt) {
        console.warn(`[logs] Gave up delivering ${this.queue.length} line(s) of deployment ${this.ids.deploymentId}.`);
        this.clearTimer();
        return;
      }
      await this.flush();
      if (this.queue.length === 0 && !this.failing && this.closedStatus) {
        try {
          await this.client.close(this.ids.deploymentId, this.ids.projectId, this.closedStatus);
          this.serviceClosed = true;
          this.clearTimer();
          return;
        } catch {
          this.failing = true;
        }
      }
      this.timer = setTimeout(() => void attempt(), Math.max(this.retryMs, 1000));
      this.timer.unref?.();
    };
    this.clearTimer();
    this.timer = setTimeout(() => void attempt(), Math.max(this.retryMs, 1000));
    this.timer.unref?.();
  }

  private schedule(ms: number): void {
    if (this.closedStatus && !this.serviceClosed && this.timer) return;
    if (this.timer && ms > 0) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private remember(entry: Queued): void {
    this.tail.push(entryToText(entry));
    if (this.tail.length > TAIL_LINES) this.tail.splice(0, this.tail.length - TAIL_LINES);
  }
}

function defaultPhase(source: LogSource): LogPhase {
  return source === "orbitops" ? "setup" : source === "neon" ? "deploy" : "build";
}

export type { LogStream };
