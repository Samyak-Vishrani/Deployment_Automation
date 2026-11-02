import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { getOwnedDeployment } from "@/lib/deployments/access";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ deploymentId: string }>;
};

/**
 * Cancels a queued or running deployment.
 *
 * The queue owns cancellation of live work; a job that was never picked up is
 * marked terminal here instead.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { deploymentId } = await context.params;
    const deployment = await getOwnedDeployment(user.id, deploymentId);
    // A provider deploy runs in its integration service, which cancels it on
    // the provider too; a local Docker build is cancelled through the queue.
    if (deployment.provider !== "local_docker") {
      return NextResponse.json(await services().providerDeployments.cancel(deployment));
    }
    return NextResponse.json(await services().deployments.cancel(deploymentId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
