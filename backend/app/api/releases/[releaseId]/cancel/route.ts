import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { ensureBootstrapped, services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ releaseId: string }>;
};

/**
 * Cancels a running release: it is marked cancelled, later stages never start,
 * and its running deploys are cancelled on Vercel and Render. A Neon
 * provisioning takes seconds and is left to finish.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { releaseId } = await context.params;
    await ensureBootstrapped();
    return NextResponse.json(await services().releases.cancel(user.id, releaseId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
