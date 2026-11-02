import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { parseComponentSet } from "@/lib/components/component-input";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/** The saved components, frontends first. Empty until the configure screen is saved. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    return NextResponse.json(await services().components.list(user.id, projectId));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Replaces the saved set with `{ components: [...] }`. Components matched on
 * (kind, rootDir) are updated in place, so their provider ids survive.
 */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const inputs = parseComponentSet(await request.json().catch(() => null));
    return NextResponse.json(await services().components.replaceAll(user.id, projectId, inputs));
  } catch (error) {
    return toErrorResponse(error);
  }
}
