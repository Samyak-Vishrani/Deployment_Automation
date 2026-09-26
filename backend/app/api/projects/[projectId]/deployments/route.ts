import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/** Deployment history for one project, newest first. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const rt = services();

    await rt.projects.findOne(user.id, projectId);
    return NextResponse.json(await rt.deployments.listForProject(projectId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
