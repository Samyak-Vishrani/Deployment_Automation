import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { ensureBootstrapped, services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/** Deploy the project's current branch head, outside of any push. */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const rt = services();

    // Proves ownership before the deployment is queued. The queue itself keys
    // on project id alone, so this is the only place the check can happen.
    await rt.projects.findOne(user.id, projectId);
    await ensureBootstrapped();

    const deployment = await rt.deployments.deployManually(projectId);
    return NextResponse.json(deployment, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
