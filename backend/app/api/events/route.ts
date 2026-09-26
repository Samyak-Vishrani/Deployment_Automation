import { toErrorResponse } from "@/lib/api/http-error";
import { sseResponse, startHeartbeat } from "@/lib/api/sse";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * App-wide change feed, so the UI can stop polling.
 *
 * Events carry identifiers and a status, never whole records: the client
 * refetches what it needs, which means a tab that missed events while asleep
 * still converges as soon as it reconnects, and there is exactly one shape of a
 * Project in the codebase.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireUser();
    const rt = services();

    return sseResponse(request, (handle) => {
      const unsubscribe = rt.events.subscribe((event) => {
        handle.send({ type: "change", data: JSON.stringify(event) });
      });
      // Without a heartbeat an idle connection is dropped by proxies and
      // tunnels, and the browser would silently stop receiving updates.
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
