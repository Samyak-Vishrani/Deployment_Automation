import { toErrorResponse } from "@/lib/api/http-error";
import { sseResponse, startHeartbeat } from "@/lib/api/sse";
import { requireUser } from "@/lib/auth/current-user";
import { getOwnedDeployment } from "@/lib/deployments/access";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ deploymentId: string }>;
};

const TERMINAL = ["success", "failed", "cancelled"];

/**
 * Live build log.
 *
 * SSE rather than a WebSocket: this is strictly one-directional, EventSource is
 * built into the browser so the frontend needs no dependency, and it rides the
 * plain HTTP response a route handler already returns.
 *
 * Replay-then-tail, so opening the page mid-build still shows the whole log. If
 * the deployment has already finished, the replay is followed immediately by
 * 'done' and the stream completes - one code path on the client for both.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireUser();
    const { deploymentId } = await context.params;
    const deployment = await getOwnedDeployment(user.id, deploymentId);

    const rt = services();
    const history = await rt.logs.read(deployment.projectId, deploymentId);
    const finished = TERMINAL.includes(deployment.status);

    return sseResponse(request, (handle) => {
      for (const line of history ? history.split("\n").filter(Boolean) : []) {
        handle.send({ type: "line", data: line });
      }

      if (finished) {
        handle.send({ type: "done", data: JSON.stringify({ status: deployment.status }) });
        handle.close();
        return;
      }

      // Subscribing only after the replay is written is what keeps the log in
      // order: a line emitted mid-replay is still queued on the stream behind
      // the history, because everything goes through the same controller.
      const unsubscribe = rt.logs.subscribe(deploymentId, (event) => {
        handle.send({ type: event.type, data: event.data });
        if (event.type === "done") {
          handle.close();
        }
      });
      const stopHeartbeat = startHeartbeat(handle);

      return () => {
        unsubscribe();
        stopHeartbeat();
      };
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
