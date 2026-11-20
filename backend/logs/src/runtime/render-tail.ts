import type { RuntimeLogEvent, RuntimeLogLine } from "@orbitops/integration-common/contract";
import { abortableSleep } from "@orbitops/integration-common/provider-fetch";
import { ProviderError } from "@orbitops/integration-common/provider-error";
import { toRenderRuntimeLines, type RenderLogPage } from "../providers/render-runtime";
import type { ProxyClient } from "./proxy-client";
import { SeenIds } from "./seen";

export interface RenderTailOptions {
  sinceMs: number;
  includeRequests: boolean;
  pollMs: number;
  signal: AbortSignal;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** One newest-first page: Render's page limit, and one call of the rate limit. */
export const BACKFILL_MAX = 100;
const SLOW_POLL_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_PAGES_PER_POLL = 3;
/** Consecutive failed polls before the stream gives up. */
const MAX_FAILURES = 5;

/**
 * Render's app logs, live. Render's /v1/logs answers one page and ends, so
 * this polls it through render_integration's log proxy:
 *
 * 1. a backfill: the newest 100 lines of the last `sinceMs`, newest first,
 *    shown oldest first;
 * 2. then a forward poll every `pollMs` from the newest line seen, overlapping
 *    pages de-duplicated by Render's log id.
 *
 * Render allows 30 log reads a minute (measured 2026-11-04: ratelimit-limit
 * 30), so the default poll is 3 s, and when the remaining quota is nearly
 * gone the next read waits for the reset. A 429 or a transient failure slows
 * down with a notice; five failures in a row end the stream.
 */
export async function* tailRender(
  proxy: Pick<ProxyClient, "renderLogs">,
  userId: string,
  componentId: string,
  options: RenderTailOptions,
): AsyncGenerator<RuntimeLogEvent> {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const types: Array<"app" | "request"> = options.includeRequests ? ["app", "request"] : ["app"];
  const seen = new SeenIds();
  const newestOf = (page: RenderLogPage) => (page.logs ?? []).reduce((max, l) => Math.max(max, Date.parse(l.timestamp ?? "") || 0), 0);

  // --------------------------------------------------------------- backfill --
  const start = now();
  const first = await proxy.renderLogs(
    userId,
    componentId,
    { types, startTime: new Date(start - options.sinceMs).toISOString(), limit: BACKFILL_MAX, direction: "backward" },
    options.signal,
  );
  const firstPage = (first.page ?? {}) as RenderLogPage;
  const backfill = toRenderRuntimeLines(firstPage, { includeRequests: options.includeRequests })
    .sort((a, b) => a.at - b.at)
    .filter((l) => seen.add(l.id));
  // Poll from the newest line seen (inclusive: it comes again and is dropped as seen), or from now.
  let cursor = new Date(newestOf(firstPage) || start).toISOString();

  yield { type: "notice", text: "Connected to Render. New app log lines appear within a few seconds." };
  if (backfill.length > 0) {
    const minutes = Math.round(options.sinceMs / 60_000);
    yield {
      type: "notice",
      text:
        firstPage.hasMore
          ? `Showing the latest ${backfill.length} lines of the last ${minutes} minutes.`
          : `${backfill.length} line${backfill.length === 1 ? "" : "s"} from the last ${minutes} minutes.`,
    };
  }
  for (const line of backfill) yield { type: "line", line };

  // ------------------------------------------------------------------- poll --
  let wait = pacing(options.pollMs, first.remaining, first.resetMs);
  let failures = 0;
  let slowNoticeShown = false;

  while (!options.signal.aborted) {
    try {
      await sleep(wait, options.signal);
    } catch {
      return; // aborted while waiting
    }
    try {
      const lines: RuntimeLogLine[] = [];
      let remaining: number | null = null;
      let resetMs: number | null = null;
      for (let i = 0; i < MAX_PAGES_PER_POLL; i++) {
        const result = await proxy.renderLogs(userId, componentId, { types, startTime: cursor, limit: 100, direction: "forward" }, options.signal);
        remaining = result.remaining;
        resetMs = result.resetMs;
        const page = (result.page ?? {}) as RenderLogPage;
        lines.push(...toRenderRuntimeLines(page, { includeRequests: options.includeRequests }));
        const newest = newestOf(page);
        if (page.hasMore && page.nextStartTime) {
          cursor = page.nextStartTime;
          continue;
        }
        if (newest > 0) cursor = new Date(newest).toISOString();
        break;
      }
      failures = 0;
      for (const line of lines) if (seen.add(line.id)) yield { type: "line", line };
      wait = pacing(options.pollMs, remaining, resetMs);
      if (wait > options.pollMs && !slowNoticeShown) {
        slowNoticeShown = true;
        yield { type: "notice", text: `Render's log API allows 30 reads a minute; the next read waits ${Math.round(wait / 1000)} s for the limit to reset.` };
      } else if (wait <= options.pollMs) {
        slowNoticeShown = false;
      }
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof ProviderError && error.status === 429) {
        wait = Math.max(SLOW_POLL_MS, (error as ProviderError & { retryAfterMs?: number }).retryAfterMs ?? 0);
        yield { type: "notice", text: `Render rate-limited the log reads; trying again in ${Math.round(wait / 1000)} s.` };
        continue;
      }
      const transient = !(error instanceof ProviderError) || Boolean(error.options?.retryable) || error.status >= 500;
      failures++;
      if (!transient || failures >= MAX_FAILURES) throw error;
      wait = Math.min(MAX_BACKOFF_MS, options.pollMs * 2 ** failures);
      yield { type: "notice", text: `Render did not answer (${(error as Error).message}); trying again in ${Math.round(wait / 1000)} s.` };
    }
  }
}

/**
 * The wait before the next read: the poll interval, or until the rate limit
 * resets when at most 2 reads are left in the window.
 */
export function pacing(pollMs: number, remaining: number | null, resetMs: number | null): number {
  if (remaining !== null && remaining <= 2) return Math.max(pollMs, Math.min(resetMs ?? SLOW_POLL_MS, 60_000));
  return pollMs;
}
