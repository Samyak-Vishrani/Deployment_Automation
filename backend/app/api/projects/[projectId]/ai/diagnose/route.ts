import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { parseAskBody } from "@/lib/ai/ai.service";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * Phase 13: "Diagnose with AI". Is anything wrong with the project as a whole,
 * what, and the ordered steps to fix it. Body `{ question?, force? }`. On
 * demand only; nothing is changed.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const options = parseAskBody(await request.json().catch(() => null));
    return NextResponse.json(await services().ai.diagnose(user.id, projectId, options));
  } catch (error) {
    return toErrorResponse(error);
  }
}
