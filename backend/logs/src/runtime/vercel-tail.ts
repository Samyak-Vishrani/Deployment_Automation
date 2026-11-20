import type { RuntimeLogEvent } from "@orbitops/integration-common/contract";
import { readNdjson } from "@orbitops/integration-common/ndjson";
import { abortableSleep } from "@orbitops/integration-common/provider-fetch";
import { ProviderError } from "@orbitops/integration-common/provider-error";
import { toVercelRuntimeLine } from "../providers/vercel-runtime";
import type { ProxyClient } from "./proxy-client";
import { SeenIds } from "./seen";

export interface VercelTailOptions {
  signal: AbortSignal;
  /** A refusal within this long (not deployed, token rejected) is an HTTP error, not a stream. */
  quickFailMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const MAX_FAILURES = 5;
const RECONNECT_MS = 1000;

type Opened = Awaited<ReturnType<ProxyClient["vercelRuntime"]>>;

/**
 * Vercel's runtime logs, live: one long read of the runtime-logs stream that
 * vercel_integration pipes through.
 *
 * Measured on 2026-11-04: Vercel sends no response at all, not even headers,
 * until there is a log line, and a site that only serves static pages never
 * logs at runtime. So this does not wait for the response before reporting
 * "connected": a refusal within `quickFailMs` (not deployed, token rejected,
 * service down) is still thrown, and becomes an HTTP error; after that it
 * just waits. When Vercel closes the stream it reconnects quietly; rows
 * already shown are skipped by their rowId. Five failures in a row end it.
 */
export async function* tailVercel(
  proxy: Pick<ProxyClient, "vercelRuntime">,
  userId: string,
  componentId: string,
  options: VercelTailOptions,
): AsyncGenerator<RuntimeLogEvent> {
  const sleep = options.sleep ?? abortableSleep;
  const seen = new SeenIds();
  const open = () => {
    const pending = proxy.vercelRuntime(userId, componentId, options.signal);
    pending.catch(() => undefined); // handled where awaited; this only silences "unhandled" while paused
    return pending;
  };

  let opening = open();
  const quick = await Promise.race([
    opening.then(
      (opened) => ({ opened }),
      (error: unknown) => ({ error }),
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), options.quickFailMs ?? 3000)),
  ]);
  if (quick && "error" in quick) throw quick.error;
  yield {
    type: "notice",
    text: "Connected to Vercel. A line appears whenever a server function or middleware runs; static pages log nothing at runtime.",
  };

  let failures = 0;
  while (!options.signal.aborted) {
    let opened: Opened;
    try {
      opened = await opening;
    } catch (error) {
      if (options.signal.aborted) return;
      failures++;
      const retryable = !(error instanceof ProviderError) || Boolean(error.options?.retryable);
      if (!retryable || failures >= MAX_FAILURES) throw error;
      const wait = RECONNECT_MS * 2 ** failures;
      yield { type: "notice", text: `Vercel did not answer (${(error as Error).message}); trying again in ${Math.round(wait / 1000)} s.` };
      try {
        await sleep(wait, options.signal);
      } catch {
        return;
      }
      opening = open();
      continue;
    }

    let bad = 0;
    try {
      for await (const raw of readNdjson(opened.body, { signal: options.signal, onBad: () => bad++ })) {
        const line = toVercelRuntimeLine(raw);
        if (line && seen.add(line.id)) {
          failures = 0;
          yield { type: "line", line };
        }
      }
    } catch {
      if (options.signal.aborted) return;
      // The stream broke; reconnect below like a normal close.
    }
    if (bad > 0) yield { type: "notice", text: `${bad} unreadable line${bad === 1 ? "" : "s"} skipped.` };
    if (options.signal.aborted) return;
    // Vercel closed the stream: reconnect quietly.
    try {
      await sleep(RECONNECT_MS, options.signal);
    } catch {
      return;
    }
    opening = open();
  }
}
