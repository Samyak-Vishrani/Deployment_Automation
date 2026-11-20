import {
  Prisma,
  type Component,
  type ComponentStatus,
  type Deployment,
  type DeploymentStatus,
  type DeploymentTrigger,
  type PrismaClient,
  type Project,
  type ProviderId,
} from "@prisma/client";
import { badRequest, HttpError, notFound } from "@/lib/api/http-error";
import { PROVIDER_LABEL } from "@/lib/components/provider-rules";
import { changedFiles, commitInfo, screenPush, shouldDeploy } from "@/lib/deployments/push-filter";
import type { PushPayload } from "@/lib/deployments/push-payload";
import type { EnvVarsService, ResolvedEnv } from "@/lib/env/env-vars.service";
import type { LogSource } from "@/lib/logs/log-types";
import { DATABASE_ENV_KEYS } from "@/lib/env/system-env";
import type { EventsService } from "@/lib/events/events.service";
import type { GithubAppService } from "@/lib/github/github-app.service";
import type { ParsedRepo } from "@/lib/github/repo-url";
import type { ProviderLogSink } from "./provider-log-sink";
import { apiUrlKey } from "./api-url-env";
import { isServiceUnavailable } from "./integration-service.client";
import type { NeonServiceClient } from "./neon-service.client";
import type { RenderServiceClient } from "./render-service.client";
import type { VercelServiceClient } from "./vercel-service.client";
import type { EventBatch, ProviderEvent, ProviderStatus } from "./vercel-service.types";

export interface DeployComponentOptions {
  trigger: DeploymentTrigger;
  commitSha?: string | null;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  /** Push dedupe key; unique per (project, deliveryId). */
  deliveryId?: string | null;
  /** The "Deploy all" this deployment belongs to (Phase 8). */
  releaseId?: string | null;
}

/** What the backend asks of the neondb_integration service. */
export type NeonClient = Pick<NeonServiceClient, "getCredential" | "ensureDatabase" | "getDatabase" | "getConnection">;

/** The env vars a Neon database gives its project's backend (moved to lib/env/system-env). */
export { DATABASE_ENV_KEYS };

/** What a deploy needs from the env vars (Phase 9). */
export type EnvResolver = Pick<EnvVarsService, "resolve">;

const noEnv: EnvResolver = { resolve: async () => ({ vars: [], secrets: [], revision: 0 }) };

type EnvVar = { key: string; value: string };

const TERMINAL: ReadonlySet<DeploymentStatus> = new Set(["success", "failed", "cancelled"]);

/** One client per provider that deploys through its own integration service. */
export interface ProviderClients {
  vercel: VercelServiceClient;
  render: RenderServiceClient;
}

export type IntegratedProvider = keyof ProviderClients;

export const isIntegrated = (provider: ProviderId): provider is IntegratedProvider =>
  provider === "vercel" || provider === "render";

/** What reconciliation needs from either service's deployment view. */
interface DeploymentStateView {
  state: ProviderStatus;
  url: string | null;
  productionUrl?: string | null;
  errorMessage: string | null;
}

/** The user-facing answer when a provider account is missing or rejected. */
const CREDENTIAL_ERRORS: Record<IntegratedProvider, { missing: string; invalid: [string, string] }> = {
  vercel: { missing: "vercel_not_connected", invalid: ["Vercel rejected the saved token.", "vercel_token_invalid"] },
  render: { missing: "render_not_connected", invalid: ["Render rejected the saved API key.", "render_key_invalid"] },
};

/** What the provider calls the resource we create per component. */
const RESOURCE_NOUN: Record<IntegratedProvider, string> = { vercel: "project", render: "service" };

/** Provider progress → the five lifecycle values every screen already understands. */
export function lifecycleStatus(status: ProviderStatus): DeploymentStatus {
  switch (status) {
    case "live":
      return "success";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      // queued on Vercel is still in flight from our point of view.
      return "running";
  }
}

/**
 * Deploys components to external providers through their integration service,
 * and applies the events those services report back.
 *
 * Vercel (backend/vercel_integration) and Render (backend/render_integration)
 * today. This class holds no provider logic: it owns the parts that belong to
 * this backend - ownership, the GitHub App (commit SHA, installation token),
 * the project's env vars, the Deployment row, the log file and the /events feed.
 */
export class ProviderDeploymentsService {
  /** Serialises event batches per deployment, so a redelivery never interleaves. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Told about every deployment that reaches a final state (the release orchestrator listens). */
  private finishedListener?: (deployment: Deployment) => void;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly github: Pick<
      GithubAppService,
      "getBranchHeadSha" | "getInstallationToken" | "resolveInstallationId" | "getRepoMetadata"
    >,
    private readonly events: EventsService,
    private readonly clients: ProviderClients,
    private readonly sink: ProviderLogSink,
    /** Neon provisions synchronously, so it is not one of the event-driven `clients`. */
    private readonly neon: NeonClient,
    /** The component's env vars, sealed in EnvVar (Phase 9). */
    private readonly envVars: EnvResolver = noEnv,
  ) {}

  /**
   * Registers the one listener for finished deployments. It is called without
   * being awaited, outside any lock, so it may start further deployments.
   */
  onDeploymentFinished(listener: (deployment: Deployment) => void): void {
    this.finishedListener = listener;
  }

  private notifyFinished(deployment: Deployment): void {
    if (!this.finishedListener) return;
    queueMicrotask(() => {
      try {
        this.finishedListener?.(deployment);
      } catch (error) {
        console.error(`[provider] Finished-deployment listener failed: ${(error as Error).message}`);
      }
    });
  }

  // -------------------------------------------------------------- deploy --

  async deployComponent(
    userId: string,
    projectId: string,
    componentId: string,
    options: DeployComponentOptions,
  ): Promise<Deployment | null> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== userId) {
      throw notFound(`Project ${projectId} not found.`);
    }
    const component = await this.prisma.component.findUnique({ where: { id: componentId } });
    if (!component || component.projectId !== projectId) {
      throw notFound(`Component ${componentId} not found.`);
    }
    if (component.provider === "local_docker") {
      throw badRequest(`${component.name} deploys with local Docker; use "Deploy now" on the project page.`);
    }
    const provider = component.provider;
    if (provider === "neon") {
      return (await this.provisionDatabase(userId, project, component, options)).deployment;
    }
    if (!isIntegrated(provider)) {
      throw badRequest(`Deploying to ${PROVIDER_LABEL[provider]} is not supported.`);
    }
    const label = PROVIDER_LABEL[provider];

    const repo = repoOf(project);
    const branch = project.branch ?? project.defaultBranch;
    if (!branch) throw badRequest(`${project.name} has no branch to deploy.`);

    const credential = await this.clients[provider].getCredential(userId);
    if (credential.state === "missing") {
      throw new HttpError(`Connect ${label} in Settings first.`, 412, CREDENTIAL_ERRORS[provider].missing);
    }
    if (credential.state === "invalid") {
      const [message, code] = CREDENTIAL_ERRORS[provider].invalid;
      throw new HttpError(`${message} Reconnect ${label} in Settings.`, 412, code);
    }

    const installationId = project.installationId ?? (await this.github.resolveInstallationId(repo));
    const commitSha = options.commitSha ?? (await this.github.getBranchHeadSha(repo, branch, installationId));
    // Read before the row exists, so the row records the revision it is sent with.
    const env = await this.envVars.resolve(projectId, component);

    let deployment: Deployment;
    try {
      deployment = await this.prisma.deployment.create({
        data: {
          projectId,
          componentId,
          provider: component.provider,
          status: "queued",
          providerStatus: "queued",
          trigger: options.trigger,
          branch,
          commitSha,
          commitMessage: options.commitMessage ?? `Deploy ${component.name} to ${label}`,
          commitAuthor: options.commitAuthor ?? null,
          deliveryId: options.deliveryId ?? null,
          releaseId: options.releaseId ?? null,
          envRevision: env.revision,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return null; // this push delivery already produced the deploy
      }
      throw error;
    }
    this.events.deploymentChanged(projectId, deployment.id, "queued");
    await this.sink.addSecrets(projectId, deployment.id, env.secrets);
    await this.sink.section(
      projectId,
      deployment.id,
      `Queued: ${component.name} → ${label} (${repo.fullName}@${branch}, ${commitSha.slice(0, 7)})`,
    );

    try {
      if (provider === "vercel") {
        const repoId = project.repoId ?? (await this.github.getRepoMetadata(repo)).id;
        // Only Vercel can need the source (its upload fallback); Render reads GitHub itself.
        const githubToken = await this.github.getInstallationToken(installationId);
        const userKeys = new Set(env.vars.map((v) => v.key));
        const publicEnvVars = await this.vercelPublicEnv(project, component, deployment.id, userKeys);
        await this.logEnvKeys(project.id, deployment.id, env);
        await this.clients.vercel.startDeployment({
          deploymentId: deployment.id,
          userId,
          component: {
            id: component.id,
            name: component.name,
            rootDir: component.rootDir,
            framework: component.framework,
            installCmd: component.installCmd,
            buildCmd: component.buildCmd,
            outputDir: component.outputDir,
            nodeVersion: component.nodeVersion,
          },
          repo: { fullName: repo.fullName, repoId, branch },
          commitSha,
          githubToken,
          ...(publicEnvVars ? { publicEnvVars } : {}),
          // The frontend's own vars (Phase 9). Values only ever travel in this body;
          // the service holds them in memory for the run, never at rest.
          envVars: env.vars,
        });
      } else {
        const envVars = await this.renderEnv(userId, project, deployment, env);
        await this.clients.render.startDeployment({
          deploymentId: deployment.id,
          userId,
          component: {
            id: component.id,
            name: component.name,
            rootDir: component.rootDir,
            framework: component.framework,
            installCmd: component.installCmd,
            buildCmd: component.buildCmd,
            startCmd: component.startCmd,
            nodeVersion: component.nodeVersion,
            healthCheckPath: component.healthCheckPath,
          },
          repo: { fullName: repo.fullName, branch },
          commitSha,
          // Shared + the backend's own (Phase 9), plus the Neon database's (Phase 8).
          // Values only ever travel in this request body.
          envVars,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the deploy.";
      await this.finishLocally(deployment, "failed", message);
      throw error;
    }
    return deployment;
  }

  /** Cancels through the integration service, which reports the terminal state back. */
  async cancel(deployment: Deployment): Promise<{ status: string }> {
    if (TERMINAL.has(deployment.status)) {
      return { status: `already ${deployment.status}` };
    }
    if (!isIntegrated(deployment.provider)) {
      throw badRequest("This deployment does not run through a provider integration.");
    }
    try {
      await this.clients[deployment.provider].cancelDeployment(deployment.id);
      return { status: "cancelling" };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        // The service never received it (it failed to start, or was down).
        await this.finishLocally(
          deployment,
          "cancelled",
          `Cancelled before it reached ${PROVIDER_LABEL[deployment.provider]}.`,
        );
        return { status: "cancelled" };
      }
      throw error;
    }
  }

  async listForComponent(userId: string, projectId: string, componentId: string, take = 20): Promise<Deployment[]> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== userId) throw notFound(`Project ${projectId} not found.`);
    return this.prisma.deployment.findMany({
      where: { projectId, componentId },
      orderBy: { queuedAt: "desc" },
      take,
    });
  }

  // -------------------------------------------------------------- events --

  /**
   * Applies one batch from the integration service. Batches for a deployment
   * arrive in order; one at or below the last applied seq is a redelivery and
   * is acknowledged without being applied again.
   */
  applyBatch(batch: EventBatch, from?: IntegratedProvider): Promise<{ applied: boolean }> {
    return this.withLock(batch.deploymentId, () =>
      this.applyEvents(batch.deploymentId, batch.events, batch.seq, from),
    );
  }

  private withLock<T>(deploymentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(deploymentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.locks.set(deploymentId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.locks.get(deploymentId) === next) this.locks.delete(deploymentId);
      });
    return next;
  }

  /** `seq` null = out-of-band (reconciliation): applied without touching the sequence. */
  private async applyEvents(
    deploymentId: string,
    events: ProviderEvent[],
    seq: number | null,
    from?: IntegratedProvider,
  ): Promise<{ applied: boolean }> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { component: true },
    });
    if (!deployment) throw notFound(`Deployment ${deploymentId} not found.`);
    if (from && deployment.provider !== from) {
      // A service may only report on its own provider's deployments: a leaked
      // Render secret must not be able to rewrite a Vercel deploy, and vice versa.
      throw new HttpError(`Deployment ${deploymentId} is not a ${PROVIDER_LABEL[from]} deployment.`, 403, "wrong_provider");
    }
    if (seq !== null && seq <= deployment.providerEventSeq) return { applied: false };

    let current: Deployment = deployment;
    for (const event of events) {
      current = await this.applyEvent(current, deployment.component, event);
    }
    if (seq !== null) {
      await this.prisma.deployment.update({ where: { id: deployment.id }, data: { providerEventSeq: seq } });
    }
    return { applied: true };
  }

  private async applyEvent(deployment: Deployment, component: Component | null, event: ProviderEvent): Promise<Deployment> {
    const { id, projectId } = deployment;
    switch (event.type) {
      case "logs":
        // Phase 12: a line the integration service wrote itself ("==> Preparing…")
        // is OrbitOps'; one it pulled from the provider is the provider's.
        await this.sink.write(
          projectId,
          id,
          event.lines.map((line) => {
            const ours = line.origin === "orbitops";
            return {
              text: line.text,
              at: line.at,
              stream: line.stream,
              source: ours ? ("orbitops" as const) : logSourceOf(deployment.provider),
              phase: line.phase ?? (ours ? ("deploy" as const) : ("build" as const)),
            };
          }),
        );
        return deployment;

      case "status": {
        if (TERMINAL.has(deployment.status)) return deployment;
        const status = lifecycleStatus(event.providerStatus);
        const updated = await this.prisma.deployment.update({
          where: { id },
          data: {
            providerStatus: event.providerStatus,
            // A terminal status is completed by the "terminal" event that follows it.
            ...(status === "running" ? { status, startedAt: deployment.startedAt ?? new Date() } : {}),
          },
        });
        if (component && event.providerStatus === "deploying" && component.status !== "deploying") {
          await this.setComponent(component, { status: "deploying" });
        }
        this.events.deploymentChanged(projectId, id, updated.status);
        return updated;
      }

      case "resource":
        if (component && component.providerResourceId !== event.providerResourceId) {
          await this.setComponent(component, { providerResourceId: event.providerResourceId });
        }
        await this.sink.write(projectId, id, [
          `${PROVIDER_LABEL[deployment.provider]} ${
            isIntegrated(deployment.provider) ? RESOURCE_NOUN[deployment.provider] : "resource"
          }: ${event.projectName} (${event.providerResourceId})`,
        ]);
        return deployment;

      case "deployment":
        return this.prisma.deployment.update({
          where: { id },
          data: {
            providerDeploymentId: event.providerDeploymentId,
            sourceMode: event.sourceMode,
            url: event.url,
            inspectorUrl: event.inspectorUrl,
          },
        });

      case "terminal": {
        const status = lifecycleStatus(event.status);
        const logTail = await this.sink.close(projectId, id, status);
        const updated = await this.prisma.deployment.update({
          where: { id },
          data: {
            status,
            providerStatus: event.status,
            errorMessage: event.errorMessage ?? null,
            finishedAt: deployment.finishedAt ?? new Date(),
            startedAt: deployment.startedAt ?? new Date(),
            logTail,
          },
        });
        if (component) {
          const next: { status: ComponentStatus; url?: string } =
            event.status === "live"
              ? { status: "live", ...(event.productionUrl ? { url: event.productionUrl } : {}) }
              : event.status === "failed"
                ? { status: "failed" }
                : // A cancelled deploy leaves the previous one serving, if there is one.
                  { status: component.url ? "live" : "configured" };
          await this.setComponent(component, next);
        }
        this.events.deploymentChanged(projectId, id, status);
        this.notifyFinished(updated);
        return updated;
      }
    }
  }

  // ----------------------------------------------------------- reconcile --

  /**
   * After this backend restarts: anything still in flight here is checked with
   * the integration service. Lost callbacks are covered by its own redelivery;
   * this catches deploys it never received and ones that finished meanwhile.
   */
  async reconcile(): Promise<void> {
    const rows = await this.prisma.deployment.findMany({
      where: { provider: { not: "local_docker" }, status: { in: ["queued", "running"] } },
    });
    const unreachable = new Set<IntegratedProvider>();
    for (const row of rows) {
      const provider = row.provider;
      if (provider === "neon") {
        await this.reconcileNeon(row).catch((error: Error) => console.warn(`[reconcile] ${row.id}: ${error.message}`));
        continue;
      }
      if (!isIntegrated(provider) || unreachable.has(provider)) continue;
      let view: DeploymentStateView;
      try {
        view = await this.clients[provider].getDeployment(row.id);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          await this.finishLocally(
            row,
            "failed",
            `The deploy never reached the ${PROVIDER_LABEL[provider]} integration service. Deploy again.`,
          );
          continue;
        }
        if (isServiceUnavailable(error)) {
          console.warn(`[reconcile] ${PROVIDER_LABEL[provider]} integration unreachable; its deploys are left as they are.`);
          unreachable.add(provider);
          continue;
        }
        throw error;
      }
      if (view.state === "live" || view.state === "failed" || view.state === "cancelled") {
        const terminal: ProviderEvent = {
          type: "terminal",
          status: view.state,
          productionUrl: view.productionUrl ?? view.url,
          errorMessage: view.errorMessage,
        };
        await this.withLock(row.id, () => this.applyEvents(row.id, [terminal], null)).catch((error: Error) =>
          console.warn(`[reconcile] ${row.id}: ${error.message}`),
        );
      }
    }
  }

  /**
   * A provisioning that was running in this process when it stopped. The
   * Neon service finished it or not; either way the row is closed, because
   * nothing here is waiting on it any more. Ensuring is idempotent, so a
   * redeploy simply carries on.
   */
  private async reconcileNeon(row: Deployment): Promise<void> {
    const component = row.componentId ? await this.prisma.component.findUnique({ where: { id: row.componentId } }) : null;
    const project = await this.prisma.project.findUnique({ where: { id: row.projectId } });
    if (!component || !project) {
      await this.finishLocally(row, "failed", "Provisioning was interrupted by a backend restart.");
      return;
    }
    let ready = false;
    let consoleUrl: string | null = null;
    try {
      const db = await this.neon.getDatabase(project.userId, component.id);
      ready = db.state === "ready";
      consoleUrl = db.consoleUrl;
      if (ready) await this.setComponent(component, { providerResourceId: db.neonProjectId, url: db.consoleUrl, status: "live" });
    } catch (error) {
      if (isServiceUnavailable(error)) throw error; // try again on the next start
    }
    if (ready) {
      await this.sink.write(row.projectId, row.id, ["The Neon database finished provisioning while the backend restarted."]);
      const logTail = await this.sink.close(row.projectId, row.id, "success");
      const updated = await this.prisma.deployment.update({
        where: { id: row.id },
        data: { status: "success", providerStatus: "live", url: consoleUrl, finishedAt: new Date(), logTail },
      });
      this.events.deploymentChanged(row.projectId, row.id, "success");
      this.notifyFinished(updated);
      return;
    }
    if (component.status === "deploying") await this.setComponent(component, { status: "failed" });
    await this.finishLocally(row, "failed", "Provisioning was interrupted by a backend restart. Deploy again; it carries on.");
  }

  // ---------------------------------------------------------- neon (phase 8) --

  /**
   * Provisions the project's database component on Neon: a Deployment row
   * (provider "neon") with its own log, so it shows in history and in a
   * release like any other step.
   *
   * Returns the row at once; `done` settles with the finished row. The
   * provisioning itself is synchronous in the Neon service (seconds), and runs
   * here in the background, the way the other providers' deploys do.
   */
  async provisionDatabase(
    userId: string,
    project: Project,
    component: Component,
    options: DeployComponentOptions,
  ): Promise<{ deployment: Deployment; done: Promise<Deployment> }> {
    const credential = await this.neon.getCredential(userId);
    if (credential.state === "missing") {
      throw new HttpError("Connect Neon in Settings first.", 412, "neon_not_connected");
    }
    if (credential.state === "invalid") {
      throw new HttpError("Neon rejected the saved API key. Reconnect Neon in Settings.", 412, "neon_key_invalid");
    }

    const branch = project.branch ?? project.defaultBranch ?? "main";
    const deployment = await this.prisma.deployment.create({
      data: {
        projectId: project.id,
        componentId: component.id,
        provider: "neon",
        status: "running",
        providerStatus: "deploying",
        trigger: options.trigger,
        branch,
        commitSha: options.commitSha ?? null,
        commitMessage: options.commitMessage ?? `Provision ${component.name} on Neon`,
        commitAuthor: options.commitAuthor ?? null,
        releaseId: options.releaseId ?? null,
        startedAt: new Date(),
      },
    });
    this.events.deploymentChanged(project.id, deployment.id, "running");
    await this.setComponent(component, { status: "deploying" });
    await this.sink.section(project.id, deployment.id, `Provisioning Neon database ${component.name} for ${project.name}`, {
      source: "neon",
    });

    const done = this.runProvisioning(userId, project, component, deployment);
    // The caller may not wait; a failure is already recorded on the row.
    done.catch(() => undefined);
    return { deployment, done };
  }

  private async runProvisioning(
    userId: string,
    project: Project,
    component: Component,
    deployment: Deployment,
  ): Promise<Deployment> {
    try {
      const db = await this.neon.ensureDatabase({
        userId,
        componentId: component.id,
        projectName: project.repo ?? project.name,
        componentName: component.name,
      });
      const lines = [
        ...(db.warning ? [`Warning: ${db.warning}`] : []),
        db.created
          ? `Created Neon project ${db.name} (${db.neonProjectId}) in ${db.regionId}, Postgres ${db.pgVersion}.`
          : `Neon database ${db.name} (${db.neonProjectId}) is ready (existing project).`,
        `Database "${db.databaseName}", role "${db.roleName}"${db.host ? `, host ${db.host}` : ""}.`,
        `The backend gets ${DATABASE_ENV_KEYS.join(" (pooled) and ")} (direct) on its next deploy.`,
        `Neon console: ${db.consoleUrl}`,
      ];
      await this.sink.write(project.id, deployment.id, lines, { source: "neon", phase: "deploy" });
      await this.setComponent(component, { providerResourceId: db.neonProjectId, url: db.consoleUrl, status: "live" });
      await this.sink.section(project.id, deployment.id, `Database ready: ${db.consoleUrl}`, { source: "neon" });
      const logTail = await this.sink.close(project.id, deployment.id, "success");
      const updated = await this.prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: "success",
          providerStatus: "live",
          url: db.consoleUrl,
          inspectorUrl: db.consoleUrl,
          finishedAt: new Date(),
          logTail,
        },
      });
      this.events.deploymentChanged(project.id, deployment.id, "success");
      this.notifyFinished(updated);
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not provision the database.";
      await this.setComponent(component, { status: "failed" });
      await this.finishLocally(deployment, "failed", `Provisioning failed: ${message}`);
      throw error;
    }
  }

  /**
   * The env vars a Render backend is deployed with: the project's own, plus,
   * when the project has a Neon database, DATABASE_URL (pooled) and
   * DATABASE_URL_UNPOOLED (direct), fetched fresh and never stored or logged.
   * A database not provisioned yet is provisioned first, so a lone backend
   * deploy works too.
   */
  private async renderEnv(userId: string, project: Project, deployment: Deployment, resolved: ResolvedEnv): Promise<EnvVar[]> {
    await this.logEnvKeys(project.id, deployment.id, resolved);
    const env: EnvVar[] = resolved.vars.map(({ key, value }) => ({ key, value }));
    const database = await this.prisma.component.findFirst({
      where: { projectId: project.id, kind: "database", provider: "neon" },
      orderBy: { createdAt: "asc" },
    });
    if (!database) return env;

    if (!database.providerResourceId || database.status !== "live") {
      await this.sink.write(project.id, deployment.id, [
        `The ${database.name} database is not provisioned yet; provisioning it on Neon first.`,
      ]);
      const { done } = await this.provisionDatabase(userId, project, database, {
        trigger: deployment.trigger,
        commitSha: deployment.commitSha,
        releaseId: deployment.releaseId,
      });
      try {
        await done;
      } catch (error) {
        throw new HttpError(
          `The ${database.name} database could not be provisioned on Neon: ${(error as Error).message}`,
          502,
          "neon_provision_failed",
        );
      }
    }

    const connection = await this.neon.getConnection(userId, database.id);
    await this.sink.addSecrets(project.id, deployment.id, [connection.pooledUri, connection.directUri]);
    const system: EnvVar[] = [
      { key: "DATABASE_URL", value: connection.pooledUri },
      { key: "DATABASE_URL_UNPOOLED", value: connection.directUri },
    ];
    const overridden = env.filter((v) => (DATABASE_ENV_KEYS as readonly string[]).includes(v.key)).map((v) => v.key);
    await this.sink.write(project.id, deployment.id, [
      `${DATABASE_ENV_KEYS.join(" and ")} come from the Neon database ${database.name}.`,
      ...(overridden.length > 0
        ? [`The project's own ${overridden.join(" and ")} ${overridden.length === 1 ? "is" : "are"} not used.`]
        : []),
    ]);
    return [...env.filter((v) => !(DATABASE_ENV_KEYS as readonly string[]).includes(v.key)), ...system];
  }

  /**
   * The public env vars a Vercel frontend is built with: its backend's URL,
   * under the key its framework exposes to browser code (NEXT_PUBLIC_API_URL
   * for Next.js). Only with exactly one backend:
   *
   * - no backend at all → [] (any URL set before is removed);
   * - one backend with a URL → [{ key, url }];
   * - one backend not deployed yet, or several → undefined: the project's env
   *   is left as it is, and the log says why.
   */
  private async vercelPublicEnv(
    project: Project,
    frontend: Component,
    deploymentId: string,
    userKeys: ReadonlySet<string> = new Set(),
  ): Promise<EnvVar[] | undefined> {
    const backends = await this.prisma.component.findMany({
      where: { projectId: project.id, kind: "backend" },
      orderBy: { createdAt: "asc" },
    });
    const key = apiUrlKey(frontend.framework, frontend.buildCmd);
    if (backends.length === 0) return [];
    // The user's own value wins (Phase 9): how a project with several backends sets it.
    if (userKeys.has(key)) {
      await this.sink.write(project.id, deploymentId, [`${key} comes from ${frontend.name}'s own env vars, so the backend's URL is not set.`]);
      return [];
    }
    if (backends.length > 1) {
      await this.sink.write(project.id, deploymentId, [
        `${backends.length} backends, so ${key} is not set automatically. Set it yourself for now.`,
      ]);
      return undefined;
    }
    const url = backends[0].url;
    if (!url) {
      await this.sink.write(project.id, deploymentId, [
        `The backend ${backends[0].name} has no URL yet, so ${key} is not set. Deploy it first, or use Deploy all.`,
      ]);
      return undefined;
    }
    await this.sink.write(project.id, deploymentId, [`${key}=${url} (the backend ${backends[0].name}).`]);
    return [{ key, value: url }];
  }

  /** One line naming the user env vars a deploy is sent with: keys only. */
  private async logEnvKeys(projectId: string, deploymentId: string, env: ResolvedEnv): Promise<void> {
    if (env.vars.length === 0) return;
    const keys = env.vars.map((v) => (v.secret ? `${v.key} (secret)` : v.key));
    await this.sink.write(projectId, deploymentId, [`Environment: ${keys.join(", ")}.`]);
  }

  // ---------------------------------------------------------------- push --

  /**
   * Push-to-deploy for provider components. Vercel's deploy-on-push and
   * Render's auto-deploy are both switched off for what we create, so this is
   * what redeploys a component when its folder changes. Only components that
   * have been deployed once (they have a provider resource) are redeployed.
   */
  async handlePush(payload: PushPayload, deliveryId?: string): Promise<number> {
    const screened = screenPush(payload);
    if (!screened.deployable) return 0;

    const projects = await this.prisma.project.findMany({
      where: { autoDeploy: true, repoId: screened.repoId, branch: screened.branch },
      include: {
        deployComponents: { where: { provider: { in: ["vercel", "render"] }, providerResourceId: { not: null } } },
      },
    });
    const files = changedFiles(payload);
    const info = commitInfo(payload);
    let queued = 0;

    for (const project of projects) {
      for (const component of project.deployComponents) {
        const watch = component.rootDir === "." ? [] : [`${component.rootDir}/**`];
        if (!shouldDeploy(watch, files)) continue;
        try {
          const deployment = await this.deployComponent(project.userId, project.id, component.id, {
            trigger: "push",
            ...info,
            deliveryId: deliveryId ? `${deliveryId}:${component.id}` : null,
          });
          if (deployment) queued++;
        } catch (error) {
          console.error(`[push] Could not deploy ${component.name} of ${project.name}: ${(error as Error).message}`);
        }
      }
    }
    return queued;
  }

  // ------------------------------------------------------------ internals --

  private async finishLocally(deployment: Deployment, status: "failed" | "cancelled", message: string): Promise<void> {
    await this.sink.write(deployment.projectId, deployment.id, [message]);
    const logTail = await this.sink.close(deployment.projectId, deployment.id, status);
    const updated = await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: { status, providerStatus: status, errorMessage: message, finishedAt: new Date(), logTail },
    });
    this.events.deploymentChanged(deployment.projectId, deployment.id, status);
    this.notifyFinished(updated);
  }

  private async setComponent(
    component: Component,
    data: Partial<Pick<Component, "status" | "url" | "providerResourceId">>,
  ): Promise<void> {
    await this.prisma.component.update({ where: { id: component.id }, data });
    Object.assign(component, data);
    this.events.projectChanged(component.projectId, "updated");
  }
}

function repoOf(project: Project): ParsedRepo {
  const fullName = project.repoFullName ?? project.githubFullName;
  const [owner, repo] = project.owner && project.repo ? [project.owner, project.repo] : (fullName ?? "").split("/");
  if (!fullName || !owner || !repo) {
    throw badRequest("No GitHub repository connected to this project.");
  }
  return { owner, repo, fullName };
}

/** The log source a provider's own output is filed under. */
function logSourceOf(provider: ProviderId): LogSource {
  return provider === "vercel" || provider === "render" || provider === "neon" ? provider : provider === "local_docker" ? "docker" : "orbitops";
}
