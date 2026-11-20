import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ analysisId: string }> };

/** One AI analysis; 404 unless it is the user's own. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { analysisId } = await context.params;
    return NextResponse.json(await services().ai.get(user.id, analysisId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
