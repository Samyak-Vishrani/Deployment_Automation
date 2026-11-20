import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { ensureBootstrapped, services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string; key: string }> };

/** The value of a non-secret SHARED variable (403 env_secret for a secret). Never cached. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId, key } = await context.params;
    await ensureBootstrapped();
    const body = await services().envVars.reveal(user.id, projectId, null, decodeURIComponent(key));
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
