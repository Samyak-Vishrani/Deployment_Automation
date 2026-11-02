import type { Prisma, RenderDeployment } from "@prisma/client";
import type { Db } from "../db";
import { badRequest, notFound, ProviderError } from "../http/provider-error";
import type { CredentialsService } from "../credentials/credentials.service";
import type { EventOutbox } from "../callbacks/outbox";
import type { RenderProvider } from "../render/render.provider";
import { isTerminal, type DeployRequest, type EnvVar, type StoredDeployInput } from "../types";
import type { DeployQueue } from "./deploy-queue";
import type { EnvVault } from "./env-vault";

/** What GET /deployments/:id returns. */
export interface DeploymentView {
  deploymentId: string;
  componentId: string;
  state: string;
  renderDeployId: string | null;
  url: string | null;
  dashboardUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export class DeploymentsService {
  constructor(
    private readonly db: Db,
    private readonly queue: Pick<DeployQueue, "add" | "cancel">,
    private readonly vault: Pick<EnvVault, "put">,
    private readonly outbox: Pick<EventOutbox, "push" | "drain">,
    private readonly credentials: Pick<CredentialsService, "getKey" | "markInvalid">,
    private readonly provider: Pick<RenderProvider, "cancel" | "setEnv" | "destroy" | "rollback">,
  ) {}

  /**
   * Accepts a deploy from the main backend. Idempotent on deploymentId: a retry
   * of the same request returns the existing state instead of deploying twice.
   */
  async start(request: DeployRequest): Promise<DeploymentView> {
    // Fail fast, before anything is queued, when there is no usable key.
    await this.credentials.getKey(request.userId);

    const existing = await this.db.renderDeployment.findUnique({ where: { deploymentId: request.deploymentId } });
    if (existing) return toView(existing);

    const { envVars, ...rest } = request;
    const stored: StoredDeployInput = { ...rest, envKeys: (envVars ?? []).map((v) => v.key) };
    const row = await this.db.renderDeployment.create({
      data: {
        deploymentId: request.deploymentId,
        userId: request.userId,
        componentId: request.component.id,
        input: stored as unknown as Prisma.InputJsonValue,
        state: "queued",
      },
    });
    this.vault.put(request.deploymentId, envVars);
    this.queue.add({ deploymentId: row.deploymentId, componentId: row.componentId });
    return toView(row);
  }

  async get(deploymentId: string): Promise<DeploymentView> {
    const row = await this.db.renderDeployment.findUnique({ where: { deploymentId } });
    if (!row) throw notFound(`Deployment ${deploymentId} is not known to the Render integration.`);
    return toView(row);
  }

  async listActive(): Promise<DeploymentView[]> {
    const rows = await this.db.renderDeployment.findMany({
      where: { state: { notIn: ["live", "failed", "cancelled"] } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toView);
  }

  /** Cancels whether the deploy is waiting, running here, or orphaned on Render. */
  async cancel(deploymentId: string): Promise<DeploymentView> {
    const row = await this.db.renderDeployment.findUnique({ where: { deploymentId } });
    if (!row) throw notFound(`Deployment ${deploymentId} is not known to the Render integration.`);
    if (isTerminal(row.state)) return toView(row);

    if (this.queue.cancel(deploymentId) === "aborted") {
      // The runner cancels on Render and reports the terminal state itself.
      return toView(row);
    }

    if (row.renderDeployId) {
      const service = await this.db.renderService.findUnique({ where: { componentId: row.componentId } });
      if (service) {
        try {
          const scope = await this.credentials.getKey(row.userId);
          await this.provider.cancel({ apiKey: scope.apiKey }, service.renderServiceId, row.renderDeployId);
        } catch (error) {
          if (error instanceof ProviderError && error.invalidToken) await this.credentials.markInvalid(row.userId);
        }
      }
    }
    return toView(await this.markFinished(row, "cancelled", "Cancelled by user."));
  }

  /**
   * On startup: a deploy Render already has is polled again; one that never
   * reached Render cannot continue (its env vars were only in memory).
   */
  async resumeAll(): Promise<{ resumed: number; failed: number }> {
    const rows = await this.db.renderDeployment.findMany({
      where: { state: { notIn: ["live", "failed", "cancelled"] } },
      orderBy: { createdAt: "asc" },
    });
    let resumed = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.renderDeployId) {
        this.queue.add({ deploymentId: row.deploymentId, componentId: row.componentId });
        resumed++;
      } else {
        await this.markFinished(
          row,
          "failed",
          "Interrupted by a restart of the Render integration service before the deploy reached Render. Deploy again.",
        );
        failed++;
      }
    }
    return { resumed, failed };
  }

  /** Phase 9 hook: upserts env vars on the component's Render service. */
  async setEnv(userId: string, componentId: string, vars: EnvVar[]): Promise<{ updated: number }> {
    const service = await this.ownedService(userId, componentId);
    const scope = await this.credentials.getKey(userId);
    await this.provider.setEnv({ apiKey: scope.apiKey }, service.renderServiceId, vars);
    return { updated: vars.length };
  }

  /** Phase 11 hook: puts a previous Render deploy back live. */
  async rollback(userId: string, componentId: string, renderDeployId: string): Promise<{ renderDeployId: string }> {
    const service = await this.ownedService(userId, componentId);
    const scope = await this.credentials.getKey(userId);
    return { renderDeployId: await this.provider.rollback({ apiKey: scope.apiKey }, service.renderServiceId, renderDeployId) };
  }

  /** Deletes the component's Render service. Not called automatically in the MVP. */
  async destroyService(userId: string, componentId: string): Promise<{ deleted: boolean }> {
    const service = await this.db.renderService.findUnique({ where: { componentId } });
    if (!service) return { deleted: false };
    if (service.userId !== userId) throw notFound(`Component ${componentId} has no Render service.`);
    const scope = await this.credentials.getKey(userId);
    await this.provider.destroy({ apiKey: scope.apiKey }, service.renderServiceId);
    await this.db.renderService.delete({ where: { componentId } });
    return { deleted: true };
  }

  private async ownedService(userId: string, componentId: string) {
    const service = await this.db.renderService.findUnique({ where: { componentId } });
    if (!service || service.userId !== userId) {
      throw badRequest("Deploy this component to Render once first.");
    }
    return service;
  }

  private async markFinished(
    row: RenderDeployment,
    state: "failed" | "cancelled",
    errorMessage: string,
  ): Promise<RenderDeployment> {
    const updated = await this.db.renderDeployment.update({
      where: { deploymentId: row.deploymentId },
      data: { state, errorMessage, finishedAt: new Date() },
    });
    this.outbox.push(row.deploymentId, { type: "status", providerStatus: state, errorMessage });
    this.outbox.push(row.deploymentId, { type: "terminal", status: state, errorMessage });
    void this.outbox.drain(row.deploymentId);
    return updated;
  }
}

export function toView(row: RenderDeployment): DeploymentView {
  return {
    deploymentId: row.deploymentId,
    componentId: row.componentId,
    state: row.state,
    renderDeployId: row.renderDeployId,
    url: row.url,
    dashboardUrl: row.dashboardUrl,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
