import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string }> };

/** The project's past AI analyses, newest first (`?take=`, default 10, max 50). */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const rt = services();
    await rt.projects.findOne(user.id, projectId); // 404 for someone else's project
    const take = Number(new URL(request.url).searchParams.get("take") ?? 10) || 10;
    return NextResponse.json(await rt.ai.list(user.id, projectId, take));
  } catch (error) {
    return toErrorResponse(error);
  }
}
