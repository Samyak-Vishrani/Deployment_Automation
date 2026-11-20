import { randomUUID } from "node:crypto";
import type { RuntimeEndReason, RuntimeLogEvent } from "@orbitops/integration-common/contract";
import { ProviderError, ServiceError } from "@orbitops/integration-common/provider-error";
import { redact } from "@orbitops/integration-common/redact";
import { StreamLimiter } from "@orbitops/integration-common/stream-limiter";

export interface SessionOptions {
  maxPerUser: number;
  /** A stream ends after this long in total. */
  maxMs: number;
  /** ...or after this long without a ping from the viewer. */
  idleMs: number;
}

export interface OpenSession {
  sessionId: string;
  events: AsyncGenerator<RuntimeLogEvent>;
  /** The viewer went away: stop the tailer. */
  abort: () => void;
}

type Source = (signal: AbortSignal) => AsyncGenerator<RuntimeLogEvent>;

const END_MESSAGES: Partial<Record<RuntimeEndReason, string>> = {
  idle: "Stopped: nobody watched this stream for a while. Resume to continue.",
  max_duration: "Stopped after the maximum stream length. Resume to continue.",
  upstream_closed: "The provider closed the log stream. Resume to reconnect.",
};

/**
 * One live runtime-log stream: the per-user limit, the idle and
 * maximum-length cutoffs, and a redaction backstop around a tailer.
 *
 * The tailer's first event is awaited before `open` returns, so a refusal
 * (not deployed, credential rejected, service down) becomes an ordinary
 * HTTP error instead of a stream that dies straight away.
 */
export class RuntimeSessions {
  private readonly limiter: StreamLimiter;
  private readonly sessions = new Map<string, { touch: () => void; abort: (reason: string) => void }>();

  constructor(private readonly options: SessionOptions) {
    this.limiter = new StreamLimiter(options.maxPerUser);
  }

  async open(userId: string, makeSource: Source): Promise<OpenSession> {
    const release = this.limiter.acquire(userId);
    if (!release) {
      throw new ServiceError(
        `At most ${this.options.maxPerUser} live log streams can be open at once. Close one (another tab?) and try again.`,
        409,
        "runtime_logs_busy",
      );
    }

    const controller = new AbortController();
    const sessionId = randomUUID();
    let idle: NodeJS.Timeout;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort("idle"), this.options.idleMs);
    };
    touch();
    const max = setTimeout(() => controller.abort("max_duration"), this.options.maxMs);
    const cleanup = () => {
      clearTimeout(idle);
      clearTimeout(max);
      this.sessions.delete(sessionId);
      release();
    };

    const source = makeSource(controller.signal);
    let first: IteratorResult<RuntimeLogEvent>;
    try {
      first = await source.next();
    } catch (error) {
      cleanup();
      controller.abort("failed");
      throw error;
    }
    this.sessions.set(sessionId, { touch, abort: (reason) => controller.abort(reason) });

    const events = (async function* (): AsyncGenerator<RuntimeLogEvent> {
      try {
        let next = first;
        while (!next.done) {
          yield scrub(next.value);
          next = await source.next();
        }
        const reason = controller.signal.aborted ? (controller.signal.reason as string) : "upstream_closed";
        if (reason === "idle" || reason === "max_duration" || reason === "upstream_closed") {
          yield { type: "end", reason, message: END_MESSAGES[reason]! };
        }
      } catch (error) {
        const reason = controller.signal.reason as string | undefined;
        if (reason === "idle" || reason === "max_duration") {
          yield { type: "end", reason, message: END_MESSAGES[reason]! };
        } else if (!controller.signal.aborted) {
          const message = error instanceof ProviderError || error instanceof ServiceError ? error.message : "The log stream failed.";
          yield { type: "end", reason: "error", message: redact(message) };
        }
      } finally {
        controller.abort("closed");
        await source.return(undefined).catch(() => undefined);
        cleanup();
      }
    })();

    return { sessionId, events, abort: () => controller.abort("client_closed") };
  }

  /** The viewer is still there; false when the session is gone. */
  ping(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    session?.touch();
    return Boolean(session);
  }

  /** Shutdown: end every open stream. */
  closeAll(): void {
    for (const session of this.sessions.values()) session.abort("shutdown");
  }

  get openCount(): number {
    return this.sessions.size;
  }
}

/** Generic redaction of every line (token shapes, URLs with passwords) before it leaves the service. */
function scrub(event: RuntimeLogEvent): RuntimeLogEvent {
  if (event.type === "line") return { type: "line", line: { ...event.line, text: redact(event.line.text) } };
  if (event.type === "notice") return { type: "notice", text: redact(event.text) };
  return event;
}
