import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string; sessionId: string }> };

/** The viewer is still watching: keeps a runtime stream from ending "idle" (sent every 60 s while visible). */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { sessionId } = await context.params;
    return NextResponse.json(await services().runtimeLogs.ping(user.id, sessionId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
