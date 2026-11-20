import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { parseAskBody } from "@/lib/ai/ai.service";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string; componentId: string }> };

/**
 * Phase 13: "Analyze with AI" for ONE entity: a component (Vercel, Render,
 * Neon), or "docker" for the project's local Docker deploys. Body
 * `{ question?, deploymentId?, force? }`.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId, componentId } = await context.params;
    const options = parseAskBody(await request.json().catch(() => null));
    return NextResponse.json(await services().ai.analyzeComponent(user.id, projectId, componentId, options));
  } catch (error) {
    return toErrorResponse(error);
  }
}
