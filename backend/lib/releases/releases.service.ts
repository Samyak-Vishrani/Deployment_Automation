import type {
  Component,
  ComponentKind,
  Deployment,
  DeploymentStatus,
  PrismaClient,
  Project,
  ProviderId,
  Release,
  ReleaseStatus,
} from "@prisma/client";
import { badRequest, HttpError, notFound } from "@/lib/api/http-error";
import type { ComponentsService } from "@/lib/components/components.service";
import { KIND_LABEL, PROVIDER_LABEL } from "@/lib/components/provider-rules";
import type { EventsService } from "@/lib/events/events.service";
import type { GithubAppService } from "@/lib/github/github-app.service";
import type { ProviderDeploymentsService } from "@/lib/providers/provider-deployments.service";
import type { ProviderLogSink } from "@/lib/providers/provider-log-sink";

/**
 * The order of a "Deploy all": each stage starts only once every deployment of
 * the one before is live. Databases first, so the backend is deployed with
 * DATABASE_URL; backends next, so the frontend is built with the backend's URL.
 */
export const STAGES: ReadonlyArray<{ kind: ComponentKind; label: string }> = [
  { kind: "database", label: "database" },
  { kind: "backend", label: "backend" },
  { kind: "frontend", label: "frontend" },
];

/** Release.stage once every stage is done. */
export const DONE_STAGE = STAGES.length;

const TERMINAL: ReadonlySet<DeploymentStatus> = new Set(["success", "failed", "cancelled"]);

/** Providers a release deploys through. Local Docker keeps its own project-wide deploy. */
const RELEASE_PROVIDERS: ProviderId[] = ["neon", "render", "vercel"];

export interface ReleaseStepView {
  stage: number;
  kind: ComponentKind;
  componentId: string;
  componentName: string;
  provider: ProviderId;
  deployment: {
    id: string;
    status: DeploymentStatus;
    providerStatus: string | null;
    url: string | null;
    errorMessage: string | null;
    queuedAt: string;
    finishedAt: string | null;
  } | null;
}

export interface ReleaseView {
  id: string;
  projectId: string;
  number: number;
  status: ReleaseStatus;
  /** 0 databases, 1 backends, 2 frontends, 3 done. */
  stage: number;
  trigger: string;
  branch: string;
  commitSha: string;
  commitMessage: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  steps: ReleaseStepView[];
}

type Providers = Pick<ProviderDeploymentsService, "deployComponent" | "cancel" | "onDeploymentFinished">;

/**
 * "Deploy all" (Phase 8): one click deploys every component of a project, in
 * order, at one commit, as a Release.
 *
 * Everything is worked out from database rows, under a per-release lock, so
 * `advance` can be called any number of times (by the finished-deployment
 * listener, after a restart, twice in a race) and only ever starts a stage
 * once.
 */
export class ReleasesService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly github: Pick<GithubAppService, "getBranchHeadSha" | "resolveInstallationId">,
    private readonly events: EventsService,
    private readonly components: Pick<ComponentsService, "preflight">,
    private readonly providers: Providers,
    private readonly sink: Pick<ProviderLogSink, "write">,
  ) {
    providers.onDeploymentFinished((deployment) => {
      if (deployment.releaseId) {
        void this.advance(deployment.releaseId).catch((error: Error) =>
          console.error(`[release] ${deployment.releaseId}: ${error.message}`),
        );
      }
    });
  }

  // --------------------------------------------------------------- start --

  async start(userId: string, projectId: string): Promise<ReleaseView> {
    const project = await this.ownedProject(userId, projectId);

    const running = await this.prisma.release.findFirst({ where: { projectId, status: "running" } });
    if (running) {
      throw new HttpError(
        `Release #${running.number} is still running. Wait for it, or cancel it first.`,
        409,
        "release_in_progress",
      );
    }

    const preflight = await this.components.preflight(userId, projectId);
    if (!preflight.ok) {
      const failing = preflight.checks.filter((c) => c.status !== "pass").map((c) => c.message);
      throw new HttpError(
        `Pre-flight has not passed, so nothing was deployed. ${failing.slice(0, 3).join(" ")}` +
          (failing.length > 3 ? ` (+${failing.length - 3} more)` : ""),
        412,
        "preflight_failed",
      );
    }

    const components = await this.releaseComponents(projectId);
    if (components.length === 0) {
      throw badRequest("No components deploy to Vercel, Render or Neon. Configure them first.");
    }

    const repo = repoOf(project);
    const branch = project.branch ?? project.defaultBranch;
    if (!branch) throw badRequest(`${project.name} has no branch to deploy.`);
    const installationId = project.installationId ?? (await this.github.resolveInstallationId(repo));
    // One commit for the whole release, so the frontend is built against the backend it ships with.
    const commitSha = await this.github.getBranchHeadSha(repo, branch, installationId);

    const release = await this.prisma.$transaction(async (tx) => {
      const last = await tx.release.findFirst({ where: { projectId }, orderBy: { number: "desc" }, select: { number: true } });
      return tx.release.create({
        data: {
          projectId,
          number: (last?.number ?? 0) + 1,
          trigger: "manual",
          branch,
          commitSha,
          commitMessage: `Deploy all (${commitSha.slice(0, 7)})`,
        },
      });
    });
    this.events.releaseChanged(projectId, release.id, release.status, release.stage);

    await this.advance(release.id);
    return this.get(userId, release.id);
  }

  // ------------------------------------------------------------- advance --

  /** Moves a running release on as far as its deployments allow. Idempotent. */
  advance(releaseId: string): Promise<void> {
    return this.withLock(releaseId, () => this.advanceLocked(releaseId));
  }

  private async advanceLocked(releaseId: string): Promise<void> {
    const release = await this.prisma.release.findUnique({ where: { id: releaseId }, include: { deployments: true } });
    if (!release || release.status !== "running") return;
    const project = await this.prisma.project.findUnique({ where: { id: release.projectId } });
    if (!project) return;
    const components = await this.releaseComponents(release.projectId);

    for (let stage = release.stage; stage < DONE_STAGE; stage++) {
      const { kind } = STAGES[stage];
      const stageComponents = components.filter((c) => c.kind === kind);
      if (stageComponents.length === 0) continue;

      const latest = latestPerComponent(release.deployments, stageComponents);
      if (latest.size === 0) {
        await this.startStage(release, project, stage, stageComponents);
        return; // the finished-deployment listener calls back
      }

      const rows = stageComponents.map((c) => ({ component: c, deployment: latest.get(c.id) ?? null }));
      const missing = rows.filter((r) => !r.deployment);
      if (missing.length > 0) {
        // A deploy of this stage never started (it threw before a row existed).
        return this.finish(release, "failed", `${KIND_LABEL[kind]} ${missing[0].component.name} did not start.`);
      }
      const broken = rows.find((r) => r.deployment!.status === "failed" || r.deployment!.status === "cancelled");
      if (broken) {
        const next = STAGES.slice(stage + 1)
          .filter((s) => components.some((c) => c.kind === s.kind))
          .map((s) => s.label);
        const status = broken.deployment!.status === "cancelled" ? "cancelled" : "failed";
        return this.finish(
          release,
          status,
          `${KIND_LABEL[kind]} ${broken.component.name} ${status === "failed" ? "failed" : "was cancelled"}` +
            (next.length > 0 ? `, so the ${next.join(" and ")} ${next.length === 1 ? "was" : "were"} not deployed.` : ".") +
            (broken.deployment!.errorMessage ? ` ${broken.deployment!.errorMessage}` : ""),
        );
      }
      if (rows.some((r) => !TERMINAL.has(r.deployment!.status))) return; // still running
      // Every deployment of this stage is live: on to the next.
    }

    await this.finish(release, "success", null);
  }

  private async startStage(release: Release, project: Project, stage: number, components: Component[]): Promise<void> {
    await this.prisma.release.update({ where: { id: release.id }, data: { stage } });
    this.events.releaseChanged(release.projectId, release.id, "running", stage);

    for (const component of components) {
      try {
        const deployment = await this.providers.deployComponent(project.userId, project.id, component.id, {
          trigger: release.trigger,
          commitSha: release.commitSha,
          commitMessage: release.commitMessage,
          releaseId: release.id,
        });
        if (deployment) {
          await this.sink.write(project.id, deployment.id, [
            `==> Release #${release.number}, step ${stage + 1} of ${DONE_STAGE}: ${STAGES[stage].label} ` +
              `(${component.name} → ${PROVIDER_LABEL[component.provider]})`,
          ]);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.finish(
          release,
          "failed",
          `${KIND_LABEL[component.kind]} ${component.name} could not start: ${message}`,
        );
        return;
      }
    }
  }

  private async finish(release: Release, status: ReleaseStatus, errorMessage: string | null): Promise<void> {
    const updated = await this.prisma.release.updateMany({
      where: { id: release.id, status: "running" },
      data: {
        status,
        errorMessage,
        finishedAt: new Date(),
        ...(status === "success" ? { stage: DONE_STAGE } : {}),
      },
    });
    if (updated.count > 0) {
      this.events.releaseChanged(release.projectId, release.id, status, status === "success" ? DONE_STAGE : release.stage);
    }
  }

  // -------------------------------------------------------------- cancel --

  async cancel(userId: string, releaseId: string): Promise<ReleaseView> {
    const release = await this.owned(userId, releaseId);
    await this.withLock(releaseId, async () => {
      const current = await this.prisma.release.findUnique({ where: { id: releaseId }, include: { deployments: true } });
      if (!current || current.status !== "running") return;
      // Marked first, so the terminal events the cancels cause do not advance it.
      await this.finish(current, "cancelled", "Cancelled.");
      for (const deployment of current.deployments) {
        if (TERMINAL.has(deployment.status) || deployment.provider === "neon") continue; // provisioning takes seconds
        await this.providers.cancel(deployment).catch((error: Error) =>
          console.warn(`[release] Could not cancel ${deployment.id}: ${error.message}`),
        );
      }
    });
    return this.get(userId, release.id);
  }

  // ---------------------------------------------------------------- read --

  async list(userId: string, projectId: string, take = 10): Promise<ReleaseView[]> {
    await this.ownedProject(userId, projectId);
    const releases = await this.prisma.release.findMany({
      where: { projectId },
      orderBy: { number: "desc" },
      take: Math.min(Math.max(take, 1), 50),
      include: { deployments: true },
    });
    const components = await this.releaseComponents(projectId);
    return releases.map((r) => toView(r, r.deployments, components));
  }

  async get(userId: string, releaseId: string): Promise<ReleaseView> {
    const release = await this.owned(userId, releaseId);
    const deployments = await this.prisma.deployment.findMany({ where: { releaseId } });
    const components = await this.releaseComponents(release.projectId);
    return toView(release, deployments, components);
  }

  /** After a backend restart: carry every running release on (its deployments were reconciled first). */
  async resumeAll(): Promise<number> {
    const running = await this.prisma.release.findMany({ where: { status: "running" }, select: { id: true } });
    for (const { id } of running) {
      await this.advance(id).catch((error: Error) => console.warn(`[release] Resume ${id}: ${error.message}`));
    }
    return running.length;
  }

  // ----------------------------------------------------------- internals --

  private releaseComponents(projectId: string): Promise<Component[]> {
    return this.prisma.component.findMany({
      where: { projectId, provider: { in: RELEASE_PROVIDERS } },
      orderBy: [{ kind: "asc" }, { rootDir: "asc" }],
    });
  }

  private async ownedProject(userId: string, projectId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== userId) throw notFound(`Project ${projectId} not found.`);
    return project;
  }

  private async owned(userId: string, releaseId: string): Promise<Release> {
    const release = await this.prisma.release.findUnique({ where: { id: releaseId }, include: { project: true } });
    if (!release || release.project.userId !== userId) throw notFound(`Release ${releaseId} not found.`);
    const { project: _project, ...rest } = release;
    void _project;
    return rest;
  }

  private withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.locks.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      });
    return next;
  }
}

/** The newest deployment of each component in this release. */
function latestPerComponent(deployments: Deployment[], components: Component[]): Map<string, Deployment> {
  const ids = new Set(components.map((c) => c.id));
  const latest = new Map<string, Deployment>();
  for (const d of deployments) {
    if (!d.componentId || !ids.has(d.componentId)) continue;
    const seen = latest.get(d.componentId);
    if (!seen || d.queuedAt > seen.queuedAt) latest.set(d.componentId, d);
  }
  return latest;
}

function toView(release: Release, deployments: Deployment[], components: Component[]): ReleaseView {
  const steps: ReleaseStepView[] = [];
  STAGES.forEach(({ kind }, stage) => {
    const stageComponents = components.filter((c) => c.kind === kind);
    const latest = latestPerComponent(deployments, stageComponents);
    for (const component of stageComponents) {
      const d = latest.get(component.id);
      steps.push({
        stage,
        kind,
        componentId: component.id,
        componentName: component.name,
        provider: component.provider,
        deployment: d
          ? {
              id: d.id,
              status: d.status,
              providerStatus: d.providerStatus,
              url: d.url,
              errorMessage: d.errorMessage,
              queuedAt: d.queuedAt.toISOString(),
              finishedAt: d.finishedAt?.toISOString() ?? null,
            }
          : null,
      });
    }
  });
  return {
    id: release.id,
    projectId: release.projectId,
    number: release.number,
    status: release.status,
    stage: release.stage,
    trigger: release.trigger,
    branch: release.branch,
    commitSha: release.commitSha,
    commitMessage: release.commitMessage,
    errorMessage: release.errorMessage,
    createdAt: release.createdAt.toISOString(),
    finishedAt: release.finishedAt?.toISOString() ?? null,
    steps,
  };
}

function repoOf(project: Project): { owner: string; repo: string; fullName: string } {
  const fullName = project.repoFullName ?? project.githubFullName;
  const [owner, repo] = project.owner && project.repo ? [project.owner, project.repo] : (fullName ?? "").split("/");
  if (!fullName || !owner || !repo) throw badRequest("No GitHub repository connected to this project.");
  return { owner, repo, fullName };
}
