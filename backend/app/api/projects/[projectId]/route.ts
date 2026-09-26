import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { parseUpdateProject } from "@/lib/projects/project-input";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    return NextResponse.json(await services().projects.findOne(user.id, projectId));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const dto = parseUpdateProject(await request.json().catch(() => null));
    return NextResponse.json(await services().projects.update(user.id, projectId, dto));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Removes the container first, then the row - see ProjectsService.remove. */
export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    return NextResponse.json(await services().projects.remove(user.id, projectId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
