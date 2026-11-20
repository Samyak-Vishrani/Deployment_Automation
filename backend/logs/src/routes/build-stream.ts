import type { LogEntry } from "@orbitops/integration-common/contract";
import type { LogStore, StoreEvent } from "../store/log-store";

export type BuildStreamItem = { type: "entry"; entry: LogEntry } | { type: "done"; status: string | null };

/**
 * A deployment's log, replayed from `afterSeq` and then tailed live.
 *
 * Race-free: the subscription is made BEFORE the replay is read, and buffered
 * events are passed on only when their seq is past the last replayed one, so
 * a line written mid-replay is delivered exactly once, in order. A finished
 * log replays and then sends `done`.
 */
export async function* buildLogStream(
  store: Pick<LogStore, "read" | "subscribe">,
  deploymentId: string,
  projectId: string,
  afterSeq: number,
  signal: AbortSignal,
): AsyncGenerator<BuildStreamItem> {
  const queue: StoreEvent[] = [];
  let wake: (() => void) | null = null;
  const unsubscribe = store.subscribe(deploymentId, (event) => {
    queue.push(event);
    wake?.();
  });
  try {
    let last = afterSeq;
    // Paged, so a 20 MB log does not have to be one array.
    for (;;) {
      const page = await store.read(deploymentId, projectId, { afterSeq: last, limit: 2000 });
      for (const entry of page.entries) {
        yield { type: "entry", entry };
        last = entry.seq;
      }
      if (page.entries.length < 2000) {
        if (page.complete) {
          yield { type: "done", status: page.status };
          return;
        }
        break;
      }
    }

    while (!signal.aborted) {
      while (queue.length > 0) {
        const event = queue.shift()!;
        if (event.type === "done") {
          yield { type: "done", status: event.status };
          return;
        }
        if (event.entry.seq <= last) continue;
        last = event.entry.seq;
        yield { type: "entry", entry: event.entry };
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      wake = null;
    }
  } finally {
    unsubscribe();
  }
}
