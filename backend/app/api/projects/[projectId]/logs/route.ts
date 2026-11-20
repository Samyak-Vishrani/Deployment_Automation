import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import prisma from "@/lib/db/prisma";
import { buildLogsIndex } from "@/lib/logs/logs-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string }> };

/** The Logs page's index: one entry per component (its own deployments, runtime availability), plus local Docker. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    return NextResponse.json(await buildLogsIndex(prisma, user.id, projectId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
