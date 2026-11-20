import type { Component, Deployment, PrismaClient, Project } from "@prisma/client";
import { notFound } from "@/lib/api/http-error";
import { redact } from "@/lib/common/redact";
import type { ComponentsService } from "@/lib/components/components.service";
import type { EnvironmentView, EnvVarsService } from "@/lib/env/env-vars.service";
import type { LogsServiceClient } from "@/lib/logs/logs-service.client";
import { containerName } from "@/lib/logs/runtime-logs.service";
import type { ReleasesService } from "@/lib/releases/releases.service";
import type { BundleComponent, BundleLog, ContextBundle } from "./ai-types";

/** The pseudo-component id for a project's local Docker deploys (they have no Component row). */
export const DOCKER_COMPONENT_ID = "docker";

const DEPLOYMENTS_PER_COMPONENT = 5;
const PROJECT_LOG_LINES = 400;
const TARGET_LOG_LINES = 1200;
const PREVIOUS_LOG_LINES = 300;

type Logs = Pick<LogsServiceClient, "excerpt" | "runtimeSnapshot" | "dockerSnapshot">;

/**
 * Gathers what the AI is told about a project (Phase 13), for the AI service
 * (backend/ai), which has no access to this database or the other services.
 *
 * - Settings, statuses, recent deployments, the latest release, pre-flight,
 *   the repo analysis's database hint.
 * - Env vars as KEYS only (own, shared, set by OrbitOps). Never a value.
 * - Log content from backend/logs: errors-first excerpts of the latest
 *   deployment per component, and a runtime snapshot (Render, Docker).
 *   Runtime lines are redacted with the component's secret env values, as
 *   the live runtime view does.
 *
 * Every outside call may fail (logs service down, GitHub unreachable); the
 * failure becomes a note in the bundle and the analysis still runs.
 */
export class AiContextBuilder {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly components: Pick<ComponentsService, "preflight">,
    private readonly envVars: Pick<EnvVarsService, "list" | "resolve">,
    private readonly releases: Pick<ReleasesService, "list">,
    private readonly logs: Logs,
  ) {}

  /** The whole project: every component, a moderate log budget each. */
  forProject(userId: string, projectId: string): Promise<ContextBundle> {
    return this.build(userId, projectId, null, null);
  }

  /** One component (or "docker"), with a bigger log budget and its last successful build for comparison. */
  forComponent(userId: string, projectId: string, componentId: string, deploymentId: string | null): Promise<ContextBundle> {
    return this.build(userId, projectId, componentId, deploymentId);
  }

  private async build(userId: string, projectId: string, targetId: string | null, pinnedDeploymentId: string | null): Promise<ContextBundle> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== userId) throw notFound(`Project ${projectId} not found.`);
    const components = await this.prisma.component.findMany({ where: { projectId }, orderBy: [{ kind: "asc" }, { rootDir: "asc" }] });
    const dockerDeploys = await this.prisma.deployment.findMany({
      where: { projectId, componentId: null, provider: "local_docker" },
      orderBy: { queuedAt: "desc" },
      take: DEPLOYMENTS_PER_COMPONENT,
    });

    if (targetId && targetId !== DOCKER_COMPONENT_ID && !components.some((c) => c.id === targetId)) {
      throw notFound(`Component ${targetId} not found.`);
    }
    if (targetId === DOCKER_COMPONENT_ID && dockerDeploys.length === 0) {
      throw notFound("This project has no local Docker deployments.");
    }

    const notes: string[] = [];
    const [env, preflight, release, repoAnalysis] = await Promise.all([
      this.envVars.list(userId, projectId).catch((e: Error) => {
        notes.push(`Env var keys could not be read (${e.message}).`);
        return null;
      }),
      this.components.preflight(userId, projectId).catch((e: Error) => {
        notes.push(`Pre-flight could not run (${e.message}).`);
        return null;
      }),
      this.releases.list(userId, projectId, 1).then((r) => r[0] ?? null).catch(() => null),
      this.repoAnalysis(projectId),
    ]);

    const bundleComponents: BundleComponent[] = [];
    for (const component of components) {
      const isTarget = component.id === targetId;
      const detailed = targetId === null || isTarget;
      bundleComponents.push(await this.component(userId, project, component, env, { detailed, isTarget, pinnedDeploymentId: isTarget ? pinnedDeploymentId : null, notes }));
    }
    if (dockerDeploys.length > 0) {
      const detailed = targetId === null || targetId === DOCKER_COMPONENT_ID;
      bundleComponents.push(await this.docker(project, dockerDeploys, env, { detailed, isTarget: targetId === DOCKER_COMPONENT_ID, pinnedDeploymentId, notes }));
    }

    const bundle: ContextBundle = {
      project: { name: project.name, repo: project.repoFullName ?? project.githubFullName ?? null, branch: project.branch ?? project.defaultBranch ?? null, createdAt: project.createdAt.toISOString() },
      repoAnalysis,
      preflight: (preflight?.checks ?? []).map((c) => ({ id: c.id, status: c.status, message: c.message })),
      release: release
        ? {
            number: release.number,
            status: release.status,
            stage: release.stage,
            errorMessage: release.errorMessage,
            steps: release.steps.map((s) => ({ kind: s.kind, componentName: s.componentName, status: s.deployment?.status ?? null })),
          }
        : null,
      components: bundleComponents,
      notes,
    };
    return scrubBundle(bundle, await this.knownSecrets(project.id, components));
  }

  /** Every secret env value of the project (shared + each component's), to scrub from the whole bundle. */
  private async knownSecrets(projectId: string, components: Component[]): Promise<string[]> {
    const sets = await Promise.all([
      this.envVars.resolve(projectId, null).catch(() => null),
      ...components.filter((c) => c.kind !== "database").map((c) => this.envVars.resolve(projectId, c).catch(() => null)),
    ]);
    return [...new Set(sets.flatMap((s) => s?.secrets ?? []))];
  }

  private async component(
    userId: string,
    project: Project,
    component: Component,
    env: EnvironmentView | null,
    options: { detailed: boolean; isTarget: boolean; pinnedDeploymentId: string | null; notes: string[] },
  ): Promise<BundleComponent> {
    const deployments = await this.prisma.deployment.findMany({
      where: { projectId: project.id, componentId: component.id },
      orderBy: { queuedAt: "desc" },
      take: DEPLOYMENTS_PER_COMPONENT,
    });
    const envView = env?.components.find((c) => c.componentId === component.id);
    const bundle: BundleComponent = {
      id: component.id,
      name: component.name,
      kind: component.kind,
      provider: component.provider,
      settings: {
        rootDir: component.rootDir,
        framework: component.framework,
        installCmd: component.installCmd,
        buildCmd: component.buildCmd,
        startCmd: component.startCmd,
        outputDir: component.outputDir,
        nodeVersion: component.nodeVersion,
        healthCheckPath: component.healthCheckPath,
      },
      status: component.status,
      url: component.url,
      env: {
        keys: envView?.vars.map((v) => v.key) ?? [],
        sharedKeys: envView?.receivesShared ? (env?.shared.map((v) => v.key) ?? []) : [],
        systemKeys: envView?.system.map((s) => s.key) ?? [],
        pendingRedeploy: envView?.pendingRedeploy ?? false,
      },
      deployments: deployments.map(deploymentView),
      log: null,
      runtime: null,
    };
    if (!options.detailed || component.provider === "neon" && deployments.length === 0) return bundle;

    // The chosen deployment (component scope), else the latest.
    let main: Deployment | null = deployments[0] ?? null;
    if (options.pinnedDeploymentId) {
      main = await this.prisma.deployment.findUnique({ where: { id: options.pinnedDeploymentId } });
      if (!main || main.componentId !== component.id) throw notFound(`Deployment ${options.pinnedDeploymentId} not found for ${component.name}.`);
      if (!deployments.some((d) => d.id === main!.id)) bundle.deployments = [deploymentView(main), ...bundle.deployments.slice(0, DEPLOYMENTS_PER_COMPONENT - 1)];
    }
    if (main) bundle.log = await this.excerpt(project.id, main.id, options.isTarget ? TARGET_LOG_LINES : PROJECT_LOG_LINES, component.name, options.notes);
    if (options.isTarget && main && main.status !== "success") {
      const lastGood = await this.prisma.deployment.findFirst({
        where: { projectId: project.id, componentId: component.id, status: "success", queuedAt: { lt: main.queuedAt } },
        orderBy: { queuedAt: "desc" },
      });
      if (lastGood) bundle.previousSuccessLog = await this.excerpt(project.id, lastGood.id, PREVIOUS_LOG_LINES, component.name, options.notes);
    }

    // Runtime lines: only for something that has run.
    const hasRun = Boolean(component.providerResourceId) && deployments.some((d) => d.status === "success");
    if (component.provider === "render" && hasRun) {
      const secrets = (await this.envVars.resolve(project.id, component).catch(() => null))?.secrets ?? [];
      try {
        const snap = await this.logs.runtimeSnapshot(userId, component.id, "render", { since: "1h", limit: 100 });
        bundle.runtime = { lines: snap.lines.map((l) => ({ ...l, text: redact(l.text, secrets) })), note: snap.note };
      } catch (error) {
        options.notes.push(`Runtime logs of ${component.name} could not be read (${(error as Error).message}).`);
      }
    } else if (component.provider === "vercel" && hasRun) {
      bundle.runtime = { lines: [], note: "Vercel keeps no runtime-log history to read back." };
    }
    return bundle;
  }

  /** The project's local Docker deploys, as a pseudo-component (id "docker"). */
  private async docker(
    project: Project,
    deployments: Deployment[],
    env: EnvironmentView | null,
    options: { detailed: boolean; isTarget: boolean; pinnedDeploymentId: string | null; notes: string[] },
  ): Promise<BundleComponent> {
    const bundle: BundleComponent = {
      id: DOCKER_COMPONENT_ID,
      name: "docker",
      kind: "backend",
      provider: "local_docker",
      settings: {
        rootDir: project.buildContext,
        framework: "docker",
        installCmd: null,
        buildCmd: `docker build -f ${project.dockerfilePath} ${project.buildContext}`,
        startCmd: null,
        outputDir: null,
        nodeVersion: null,
        healthCheckPath: null,
      },
      status: project.containerId ? "live" : (deployments[0]?.status ?? "configured"),
      url: project.hostPort ? `http://localhost:${project.hostPort}` : null,
      env: { keys: [], sharedKeys: env?.shared.map((v) => v.key) ?? [], systemKeys: [], pendingRedeploy: false },
      deployments: deployments.map(deploymentView),
      log: null,
      runtime: null,
    };
    if (!options.detailed) return bundle;
    const pinned = options.isTarget && options.pinnedDeploymentId ? deployments.find((d) => d.id === options.pinnedDeploymentId) : null;
    const main = pinned ?? deployments[0];
    if (main) bundle.log = await this.excerpt(project.id, main.id, options.isTarget ? TARGET_LOG_LINES : PROJECT_LOG_LINES, "docker", options.notes);
    if (project.containerId) {
      const secrets = (await this.envVars.resolve(project.id, null).catch(() => null))?.secrets ?? [];
      try {
        const snap = await this.logs.dockerSnapshot(containerName(project), { since: "1h", limit: 100 });
        bundle.runtime = { lines: snap.lines.map((l) => ({ ...l, text: redact(l.text, secrets) })), note: snap.note };
      } catch (error) {
        options.notes.push(`The Docker container's logs could not be read (${(error as Error).message}).`);
      }
    }
    return bundle;
  }

  private async excerpt(projectId: string, deploymentId: string, maxLines: number, name: string, notes: string[]): Promise<BundleLog | null> {
    try {
      const ex = await this.logs.excerpt(deploymentId, projectId, maxLines);
      return {
        deploymentId,
        entries: ex.entries.map((e) => ({ seq: e.seq, at: e.at, source: e.source, stream: e.stream, text: e.text, ...(e.repeat ? { repeat: e.repeat } : {}) })),
        totalLines: ex.totalLines,
        errorLines: ex.errorLines,
        truncated: ex.truncated,
      };
    } catch (error) {
      notes.push(`The build log of ${name} could not be read (${(error as Error).message}).`);
      return null;
    }
  }

  private async repoAnalysis(projectId: string): Promise<ContextBundle["repoAnalysis"]> {
    const analysis = await this.prisma.analysis
      .findFirst({ where: { projectId, status: "succeeded" }, orderBy: { createdAt: "desc" }, include: { components: true } })
      .catch(() => null);
    if (!analysis) return null;
    const db = analysis.database as { detected?: boolean; engine?: string } | null;
    return {
      components: analysis.components.slice(0, 10).map((c) => ({ path: c.path, framework: c.framework, role: c.role })),
      database: db ? { detected: Boolean(db.detected), engine: db.engine ?? null } : null,
    };
  }
}

function deploymentView(d: Deployment): BundleComponent["deployments"][number] {
  return {
    id: d.id,
    status: d.status,
    trigger: d.trigger,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage?.split("\n")[0]?.slice(0, 200) ?? null,
    errorMessage: d.errorMessage?.slice(0, 500) ?? null,
    providerStatus: d.providerStatus,
    queuedAt: d.queuedAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
  };
}

/** user:password@ in any URL (a connection string a log printed). */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

/**
 * The last pass over the whole bundle: every string loses the project's
 * secret env values and any password embedded in a URL. Whatever a log,
 * error message or runtime line printed, no value leaves this backend.
 */
export function scrubBundle(bundle: ContextBundle, secrets: string[]): ContextBundle {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value, secrets).replace(URL_CREDENTIALS, "$1***REDACTED***@");
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(bundle) as ContextBundle;
}
