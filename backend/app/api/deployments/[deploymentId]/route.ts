import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { getOwnedDeployment } from "@/lib/deployments/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ deploymentId: string }>;
};

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { deploymentId } = await context.params;
    return NextResponse.json(await getOwnedDeployment(user.id, deploymentId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
