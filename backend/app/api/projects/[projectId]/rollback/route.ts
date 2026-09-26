import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { ensureBootstrapped, services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/** Redeploy the image that ran before the current one. No fetch, no build. */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const rt = services();

    await rt.projects.findOne(user.id, projectId);
    await ensureBootstrapped();

    const deployment = await rt.deployments.rollback(projectId);
    return NextResponse.json(deployment, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
