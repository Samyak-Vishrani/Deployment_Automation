import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Analyses the project's branch at its current commit.
 *
 * Re-analysing a commit that already has a snapshot returns that snapshot;
 * `?force=1` runs it again regardless.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const force = ["1", "true"].includes(new URL(request.url).searchParams.get("force") ?? "");
    return NextResponse.json(await services().analysis.analyze(user.id, projectId, { force }));
  } catch (error) {
    return toErrorResponse(error);
  }
}
