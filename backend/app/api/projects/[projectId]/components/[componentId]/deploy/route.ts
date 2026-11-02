import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { ensureBootstrapped, services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string; componentId: string }>;
};

/**
 * Deploys one component to its provider (Vercel today) at the branch's current
 * head. Answers 202 with the queued Deployment; progress arrives on /api/events
 * and the build log on /api/deployments/:id/logs/stream, as for Docker builds.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId, componentId } = await context.params;
    await ensureBootstrapped();
    const deployment = await services().providerDeployments.deployComponent(user.id, projectId, componentId, {
      trigger: "manual",
    });
    return NextResponse.json(deployment, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
