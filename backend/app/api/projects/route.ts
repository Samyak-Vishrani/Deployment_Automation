import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { parseCreateProject } from "@/lib/projects/project-input";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every project the signed-in user owns, newest first. */
export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    return NextResponse.json(await services().projects.findAll(user.id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Creates a project from a GitHub repository URL.
 *
 * Talks to GitHub before it writes anything: the numeric repo id is what an
 * incoming push is matched against, so a project that could not resolve one
 * would be silently undeployable.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const dto = parseCreateProject(await request.json().catch(() => null));
    const project = await services().projects.create(user.id, dto);
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
