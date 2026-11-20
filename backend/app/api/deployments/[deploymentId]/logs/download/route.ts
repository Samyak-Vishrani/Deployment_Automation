import prisma from "@/lib/db/prisma";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { getOwnedDeployment } from "@/lib/deployments/access";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ deploymentId: string }>;
};

const PROVIDER_FILE: Record<string, string> = { vercel: "vercel", render: "render", neon: "neon", local_docker: "docker" };
const safe = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";

/**
 * One deployment's log as a plain-text file, named after its component and
 * provider (`shop-web-vercel-1a2b3c4-<id>.log`). Already redacted when written.
 */
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireUser();
    const { deploymentId } = await context.params;
    const deployment = await getOwnedDeployment(user.id, deploymentId);
    const [project, component] = await Promise.all([
      prisma.project.findUnique({ where: { id: deployment.projectId }, select: { slug: true, name: true } }),
      deployment.componentId ? prisma.component.findUnique({ where: { id: deployment.componentId }, select: { name: true } }) : null,
    ]);
    const text = await services().logs.read(deployment.projectId, deploymentId);
    const name = [
      safe(project?.slug ?? project?.name ?? "project"),
      safe(component?.name ?? "project"),
      PROVIDER_FILE[deployment.provider] ?? "log",
      ...(deployment.commitSha ? [deployment.commitSha.slice(0, 7)] : []),
      deploymentId,
    ].join("-");
    return new Response(text, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${name}.log"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
