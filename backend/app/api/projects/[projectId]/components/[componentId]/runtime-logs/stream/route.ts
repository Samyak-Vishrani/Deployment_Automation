import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { runtimeOptions, runtimeSse } from "@/lib/logs/runtime-sse";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string; componentId: string }> };

/**
 * Live runtime logs of ONE component (Phase 12): Render app logs or Vercel
 * function logs, tailed by the logs service while this stream is open and
 * never stored. `?since=5m|15m|1h&requests=0|1` (requests: Render only).
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireUser();
    const { projectId, componentId } = await context.params;
    const options = runtimeOptions(new URL(request.url));
    const upstream = new AbortController();
    const opened = await services().runtimeLogs.open(user.id, projectId, componentId, options, upstream.signal);
    return runtimeSse(request, opened, upstream);
  } catch (error) {
    return toErrorResponse(error);
  }
}
