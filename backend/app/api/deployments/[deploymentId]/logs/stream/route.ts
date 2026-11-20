import { toErrorResponse } from "@/lib/api/http-error";
import { sseResponse, startHeartbeat, type SseHandle } from "@/lib/api/sse";
import { requireUser } from "@/lib/auth/current-user";
import { getOwnedDeployment } from "@/lib/deployments/access";
import type { BuildStreamEvent } from "@/lib/logs/log-types";
import { readNdjson } from "@/lib/logs/ndjson";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ deploymentId: string }>;
};

const TERMINAL = ["success", "failed", "cancelled"];

/**
 * One deployment's build log, live (Phase 12: read from the logs service).
 *
 * Each line is `event: entry`, `id: <seq>`, `data: <LogEntry JSON>`; the log
 * ends with `done`. Replay-then-tail, so opening the page mid-build still
 * shows the whole log. A reconnecting EventSource sends `Last-Event-ID` and
 * gets only what it missed (`?afterSeq=` does the same).
 *
 * A finished deployment is read in pages and closed with its own status, so
 * the page never waits on a log the logs service did not see closed (it was
 * down when the deploy ended).
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireUser();
    const { deploymentId } = await context.params;
    const deployment = await getOwnedDeployment(user.id, deploymentId);
    const url = new URL(request.url);
    const resume = Number(request.headers.get("last-event-id") ?? url.searchParams.get("afterSeq") ?? 0);
    const afterSeq = Number.isInteger(resume) && resume > 0 ? resume : 0;
    const logs = services().logs;
    const done = (handle: SseHandle, status: string | null) => {
      handle.send({ type: "done", data: JSON.stringify({ status: status ?? deployment.status }) });
      handle.close();
    };

    if (TERMINAL.includes(deployment.status)) {
      // Read before the response starts, so a logs-service outage is a normal JSON error.
      const first = await logs.entries(deployment.projectId, deploymentId, { afterSeq, limit: 5000 });
      return sseResponse(request, (handle) => {
        void (async () => {
          let page = first;
          for (;;) {
            for (const entry of page.entries) handle.send({ type: "entry", id: String(entry.seq), data: JSON.stringify(entry) });
            if (page.entries.length < 5000) break;
            page = await logs.entries(deployment.projectId, deploymentId, { afterSeq: page.nextSeq, limit: 5000 });
          }
          done(handle, deployment.status);
        })().catch(() => handle.close());
      });
    }

    const upstream = new AbortController();
    const response = await logs.openStream(deployment.projectId, deploymentId, afterSeq, upstream.signal);
    return sseResponse(request, (handle) => {
      void (async () => {
        for await (const event of readNdjson<BuildStreamEvent>(response.body, upstream.signal)) {
          if (event.type === "entry") {
            handle.send({ type: "entry", id: String(event.entry.seq), data: JSON.stringify(event.entry) });
          } else if (event.type === "done") {
            done(handle, event.status);
            return;
          }
        }
        // The logs service went away mid-stream: closing lets EventSource reconnect with Last-Event-ID.
        handle.close();
      })().catch(() => handle.close());
      const stopHeartbeat = startHeartbeat(handle);
      return () => {
        stopHeartbeat();
        upstream.abort();
      };
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
