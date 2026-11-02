import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string; componentId: string }>;
};

/** The component's last 20 deployments, newest first. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId, componentId } = await context.params;
    return NextResponse.json(
      await services().providerDeployments.listForComponent(user.id, projectId, componentId),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
