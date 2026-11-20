import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { ensureBootstrapped, services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * "Deploy all" (Phase 8): every component of the project at the branch head,
 * in order: the Neon database, then the Render backend (with DATABASE_URL),
 * then the Vercel frontend (with the backend's URL). Answers 202 with the
 * Release; progress arrives on /api/events as "release" and "deployment"
 * events.
 *
 * 409 release_in_progress: one is already running. 412 preflight_failed:
 * nothing was deployed.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    await ensureBootstrapped();
    return NextResponse.json(await services().releases.start(user.id, projectId), { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** The project's releases, newest first (`?take=`, default 10, at most 50). */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const take = Number(new URL(request.url).searchParams.get("take") ?? 10);
    return NextResponse.json(await services().releases.list(user.id, projectId, Number.isFinite(take) ? take : 10));
  } catch (error) {
    return toErrorResponse(error);
  }
}
