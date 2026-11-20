import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { runtimeOptions, runtimeSse } from "@/lib/logs/runtime-sse";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string }> };

/** Live logs of the project's local Docker container (`docker logs --follow`, run by the logs service). */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const options = runtimeOptions(new URL(request.url));
    const upstream = new AbortController();
    const opened = await services().runtimeLogs.open(user.id, projectId, null, options, upstream.signal);
    return runtimeSse(request, opened, upstream);
  } catch (error) {
    return toErrorResponse(error);
  }
}
