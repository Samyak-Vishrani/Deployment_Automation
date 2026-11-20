import { NextResponse } from "next/server";
import { badRequest, toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ analysisId: string }> };

/** `{ helpful: boolean }`: whether the analysis helped. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { analysisId } = await context.params;
    const body = (await request.json().catch(() => null)) as { helpful?: unknown } | null;
    if (typeof body?.helpful !== "boolean") throw badRequest("helpful must be true or false.");
    return NextResponse.json(await services().ai.feedback(user.id, analysisId, body.helpful));
  } catch (error) {
    return toErrorResponse(error);
  }
}
