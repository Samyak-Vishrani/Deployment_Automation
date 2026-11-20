import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { parseEnvPut } from "@/lib/env/env-input";
import { ensureBootstrapped, services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string; componentId: string }> };

/**
 * Replaces one component's own set. A value left out keeps the stored one;
 * keys left out are deleted. Answers with the whole project's EnvironmentView.
 */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId, componentId } = await context.params;
    const dto = parseEnvPut(await request.json().catch(() => null));
    await ensureBootstrapped();
    return NextResponse.json(await services().envVars.put(user.id, projectId, componentId, dto));
  } catch (error) {
    return toErrorResponse(error);
  }
}
