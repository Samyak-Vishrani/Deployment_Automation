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
import type { EventsService } from "@/lib/events/events.service";
import type { GithubAppService } from "@/lib/github/github-app.service";
import type { ParsedRepo } from "@/lib/github/repo-url";
import type { ProviderLogSink } from "./provider-log-sink";
import { isServiceUnavailable } from "./integration-service.client";
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
}

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

  constructor(
    private readonly prisma: PrismaClient,
    private readonly github: Pick<
      GithubAppService,
      "getBranchHeadSha" | "getInstallationToken" | "resolveInstallationId" | "getRepoMetadata"
    >,
    private readonly events: EventsService,
    private readonly clients: ProviderClients,
    private readonly sink: ProviderLogSink,
  ) {}

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
    if (!isIntegrated(provider)) {
      throw badRequest(`Deploying to ${PROVIDER_LABEL[provider]} arrives in a later phase (Neon: Phase 8).`);
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
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return null; // this push delivery already produced the deploy
      }
      throw error;
    }
    this.events.deploymentChanged(projectId, deployment.id, "queued");
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
        });
      } else {
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
          // Phase 7 sends the project's env vars; Phase 9 swaps in encrypted per-component vars.
          envVars: projectEnvVars(project),
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
        await this.sink.write(
          projectId,
          id,
          event.lines.map((line) => line.text),
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
    await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: { status, providerStatus: status, errorMessage: message, finishedAt: new Date(), logTail },
    });
    this.events.deploymentChanged(deployment.projectId, deployment.id, status);
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

/** The project's env vars as a list. Values travel only to the integration service, never to logs. */
export function projectEnvVars(project: Pick<Project, "envVars">): Array<{ key: string; value: string }> {
  const raw = (project.envVars ?? {}) as Record<string, unknown>;
  return Object.entries(raw)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]))
    .map(([key, value]) => ({ key, value }));
}

function repoOf(project: Project): ParsedRepo {
  const fullName = project.repoFullName ?? project.githubFullName;
  const [owner, repo] = project.owner && project.repo ? [project.owner, project.repo] : (fullName ?? "").split("/");
  if (!fullName || !owner || !repo) {
    throw badRequest("No GitHub repository connected to this project.");
  }
  return { owner, repo, fullName };
}
