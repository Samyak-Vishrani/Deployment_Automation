import type { ComponentKind, DeploymentStatus, DeploymentTrigger, PrismaClient, ProviderId } from "@prisma/client";
import { notFound } from "@/lib/api/http-error";
import { NEON_RUNTIME_NOTE } from "./runtime-logs.service";

export interface LogsIndexDeployment {
  id: string;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  queuedAt: string;
  finishedAt: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  releaseNumber: number | null;
}

export interface LogsIndexComponent {
  componentId: string;
  name: string;
  kind: ComponentKind;
  provider: ProviderId;
  runtime: "available" | "not_deployed" | "unsupported";
  runtimeNote: string | null;
  deployments: LogsIndexDeployment[];
}

/** What the Logs page needs: one tab per component, each with only its own deployments. */
export interface LogsIndex {
  projectId: string;
  components: LogsIndexComponent[];
  /** The project's local Docker deploys, when there are any. */
  docker: { deployments: LogsIndexDeployment[]; runtime: "available" | "not_running" } | null;
}

const KIND_ORDER: Record<ComponentKind, number> = { frontend: 0, backend: 1, database: 2 };
const PER_COMPONENT = 20;

/**
 * The Logs page's index (Phase 12), from this backend's own Component and
 * Deployment rows: metadata, not log content. Every component lists only its
 * own deployments; nothing is ever combined across components.
 */
export async function buildLogsIndex(prisma: PrismaClient, userId: string, projectId: string): Promise<LogsIndex> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw notFound(`Project ${projectId} not found.`);

  const components = await prisma.component.findMany({ where: { projectId } });
  const [byComponent, docker] = await Promise.all([
    Promise.all(
      components.map((c) =>
        prisma.deployment.findMany({ where: { projectId, componentId: c.id }, orderBy: { queuedAt: "desc" }, take: PER_COMPONENT }),
      ),
    ),
    prisma.deployment.findMany({ where: { projectId, componentId: null, provider: "local_docker" }, orderBy: { queuedAt: "desc" }, take: PER_COMPONENT }),
  ]);

  const releaseIds = [...new Set([...byComponent.flat(), ...docker].map((d) => d.releaseId).filter((id): id is string => Boolean(id)))];
  const releases = releaseIds.length
    ? await prisma.release.findMany({ where: { id: { in: releaseIds } }, select: { id: true, number: true } })
    : [];
  const releaseNumber = new Map(releases.map((r) => [r.id, r.number]));
  const view = (d: (typeof docker)[number]): LogsIndexDeployment => ({
    id: d.id,
    status: d.status,
    trigger: d.trigger,
    queuedAt: d.queuedAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    releaseNumber: d.releaseId ? (releaseNumber.get(d.releaseId) ?? null) : null,
  });

  return {
    projectId,
    components: components
      .map((c, i) => {
        const deployments = byComponent[i];
        const live = Boolean(c.providerResourceId) && deployments.some((d) => d.status === "success");
        const runtime: LogsIndexComponent["runtime"] = c.provider === "neon" ? "unsupported" : live ? "available" : "not_deployed";
        return {
          componentId: c.id,
          name: c.name,
          kind: c.kind,
          provider: c.provider,
          runtime,
          runtimeNote: c.provider === "neon" ? NEON_RUNTIME_NOTE : null,
          deployments: deployments.map(view),
        };
      })
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name)),
    docker: docker.length > 0 ? { deployments: docker.map(view), runtime: project.containerId ? "available" : "not_running" } : null,
  };
}
