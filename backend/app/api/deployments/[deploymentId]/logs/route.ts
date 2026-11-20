import { NextResponse } from "next/server";
import { badRequest, toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { getOwnedDeployment } from "@/lib/deployments/access";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ deploymentId: string }>;
};

/**
 * One deployment's log, from the logs service (backend/logs).
 *
 * - default: `{ id, log }`, the whole log as text (the pre-Phase-12 shape);
 * - `?format=entries&afterSeq=&limit=`: `{ id, componentId, provider, entries, nextSeq, complete }`,
 *   structured lines tagged with their source (orbitops | vercel | render | neon | docker).
 *
 * Always ONE deployment: nothing here merges the logs of several.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { deploymentId } = await context.params;
    const deployment = await getOwnedDeployment(user.id, deploymentId);
    const url = new URL(request.url);
    const rt = services();

    if (url.searchParams.get("format") === "entries") {
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 5000);
      if (!Number.isInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1) {
        throw badRequest("afterSeq and limit must be non-negative integers.");
      }
      const result = await rt.logs.entries(deployment.projectId, deploymentId, { afterSeq, limit: Math.min(limit, 5000) });
      return NextResponse.json({
        id: deploymentId,
        componentId: deployment.componentId,
        provider: deployment.provider,
        entries: result.entries,
        nextSeq: result.nextSeq,
        complete: result.complete,
        truncated: result.truncated,
      });
    }

    const log = await rt.logs.read(deployment.projectId, deploymentId);
    return NextResponse.json({ id: deploymentId, log });
  } catch (error) {
    return toErrorResponse(error);
  }
}
