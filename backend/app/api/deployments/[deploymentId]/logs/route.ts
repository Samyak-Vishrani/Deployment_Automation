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

/** The whole log in one response, for a finished deployment. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { deploymentId } = await context.params;
    const deployment = await getOwnedDeployment(user.id, deploymentId);
    const log = await services().logs.read(deployment.projectId, deploymentId);
    return NextResponse.json({ id: deploymentId, log });
  } catch (error) {
    return toErrorResponse(error);
  }
}
