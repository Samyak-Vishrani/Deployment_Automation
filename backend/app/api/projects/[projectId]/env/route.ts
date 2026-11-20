import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { parseEnvPut } from "@/lib/env/env-input";
import { ensureBootstrapped, services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string }> };

/** Every scope's variables: keys and flags only, never a value (Phase 9). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    await ensureBootstrapped();
    return NextResponse.json(await services().envVars.list(user.id, projectId));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Replaces the SHARED set (every backend + local Docker). Applies on the next deploy. */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const dto = parseEnvPut(await request.json().catch(() => null));
    await ensureBootstrapped();
    return NextResponse.json(await services().envVars.put(user.id, projectId, null, dto));
  } catch (error) {
    return toErrorResponse(error);
  }
}
