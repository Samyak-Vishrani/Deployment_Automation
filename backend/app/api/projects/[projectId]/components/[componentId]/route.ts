import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { parseUpdateComponent } from "@/lib/components/component-input";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string; componentId: string }>;
};

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId, componentId } = await context.params;
    const dto = parseUpdateComponent(await request.json().catch(() => null));
    return NextResponse.json(
      await services().components.update(user.id, projectId, componentId, dto),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId, componentId } = await context.params;
    return NextResponse.json(await services().components.remove(user.id, projectId, componentId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
