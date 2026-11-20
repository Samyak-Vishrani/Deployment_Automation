import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string; componentId: string }> };

/**
 * Keys from the component's `<rootDir>/.env.example` at the branch head, for
 * "Add from .env.example". This static segment wins over env/[key], so a
 * variable literally named "suggestions" cannot be revealed (it can be set).
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId, componentId } = await context.params;
    return NextResponse.json(await services().envVars.suggestions(user.id, projectId, componentId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
