import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ releaseId: string }>;
};

/** One release with a step per component: Database → Backend → Frontend, and each step's deployment. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { releaseId } = await context.params;
    return NextResponse.json(await services().releases.get(user.id, releaseId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
