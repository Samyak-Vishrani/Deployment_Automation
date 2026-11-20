import { badRequest } from "@/lib/api/http-error";
import { sseResponse, startHeartbeat } from "@/lib/api/sse";
import type { RuntimeStreamOptions } from "./logs-service.client";
import type { OpenedRuntime } from "./runtime-logs.service";

const SINCE = new Set(["5m", "15m", "1h"]);

/** `?since=5m|15m|1h&requests=0|1` from a runtime-logs URL. */
export function runtimeOptions(url: URL): RuntimeStreamOptions {
  const since = url.searchParams.get("since") ?? "15m";
  if (!SINCE.has(since)) throw badRequest("since must be 5m, 15m or 1h.");
  const requests = url.searchParams.get("requests");
  return { since: since as RuntimeStreamOptions["since"], requests: requests === "1" || requests === "true" };
}

/**
 * A runtime stream as SSE: `session` first ({ sessionId }, for the ping),
 * then `entry` / `notice`, and `end` when the logs service ends it. Closing
 * the tab aborts `upstream`, which closes the logs service's tailer.
 */
export function runtimeSse(request: Request, opened: OpenedRuntime, upstream: AbortController): Response {
  return sseResponse(request, (handle) => {
    handle.send({ type: "session", data: JSON.stringify({ sessionId: opened.sessionId, source: opened.source }) });
    void (async () => {
      for await (const event of opened.events) {
        if (event.type === "entry") handle.send({ type: "entry", data: JSON.stringify(event.entry) });
        else if (event.type === "notice") handle.send({ type: "notice", data: JSON.stringify({ text: event.text }) });
        else handle.send({ type: "end", data: JSON.stringify({ reason: event.reason, message: event.message }) });
      }
      handle.close();
    })().catch(() => {
      handle.send({ type: "end", data: JSON.stringify({ reason: "error", message: "The log stream was interrupted. Resume to reconnect." }) });
      handle.close();
    });
    const stopHeartbeat = startHeartbeat(handle);
    return () => {
      stopHeartbeat();
      upstream.abort();
    };
  });
}
