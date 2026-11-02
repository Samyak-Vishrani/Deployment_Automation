import type { Prisma, VercelDeployment } from "@prisma/client";
import type { Db } from "../db";
import { badRequest, notFound, ProviderError } from "../http/provider-error";
import type { CredentialsService } from "../credentials/credentials.service";
import type { EventOutbox } from "../callbacks/outbox";
import { isTerminal, type DeployRequest, type StoredDeployInput } from "../types";
import type { EnvVarInput, VercelProvider } from "../vercel/vercel.provider";
import type { DeployQueue } from "./deploy-queue";
import type { TokenVault } from "./token-vault";

/** What GET /deployments/:id returns: the state, never the input's token (it has none). */
export interface DeploymentView {
  deploymentId: string;
  componentId: string;
  state: string;
  vercelDeploymentId: string | null;
  sourceMode: string | null;
  url: string | null;
  inspectorUrl: string | null;
  productionUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export class DeploymentsService {
  constructor(
    private readonly db: Db,
    private readonly queue: Pick<DeployQueue, "add" | "cancel">,
    private readonly tokens: Pick<TokenVault, "put">,
    private readonly outbox: Pick<EventOutbox, "push" | "drain">,
    private readonly credentials: Pick<CredentialsService, "getToken" | "markInvalid">,
    private readonly provider: Pick<VercelProvider, "cancel" | "setEnv" | "destroy">,
  ) {}

  /**
   * Accepts a deploy from the main backend. Idempotent on deploymentId: a retry
   * of the same request returns the existing state instead of deploying twice.
   */
  async start(request: DeployRequest): Promise<DeploymentView> {
    // Fail fast, before anything is queued, when there is no usable token.
    await this.credentials.getToken(request.userId);

    const existing = await this.db.vercelDeployment.findUnique({ where: { deploymentId: request.deploymentId } });
    if (existing) return toView(existing);

    const { githubToken, ...stored } = request;
    const row = await this.db.vercelDeployment.create({
      data: {
        deploymentId: request.deploymentId,
        userId: request.userId,
        componentId: request.component.id,
        input: stored satisfies StoredDeployInput as unknown as Prisma.InputJsonValue,
        state: "queued",
      },
    });
    this.tokens.put(request.deploymentId, githubToken);
    this.queue.add({ deploymentId: row.deploymentId, componentId: row.componentId });
    return toView(row);
  }

  async get(deploymentId: string): Promise<DeploymentView> {
    const row = await this.db.vercelDeployment.findUnique({ where: { deploymentId } });
    if (!row) throw notFound(`Deployment ${deploymentId} is not known to the Vercel integration.`);
    return toView(row);
  }

  async listActive(): Promise<DeploymentView[]> {
    const rows = await this.db.vercelDeployment.findMany({
      where: { state: { notIn: ["live", "failed", "cancelled"] } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toView);
  }

  /** Cancels whether the deploy is waiting, running here, or orphaned on Vercel. */
  async cancel(deploymentId: string): Promise<DeploymentView> {
    const row = await this.db.vercelDeployment.findUnique({ where: { deploymentId } });
    if (!row) throw notFound(`Deployment ${deploymentId} is not known to the Vercel integration.`);
    if (isTerminal(row.state)) return toView(row);

    const result = this.queue.cancel(deploymentId);
    if (result === "aborted") {
      // The runner cancels on Vercel and reports the terminal state itself.
      return toView(row);
    }

    // Never started here, or not running in this process: finish it ourselves.
    if (row.vercelDeploymentId) {
      try {
        const scope = await this.credentials.getToken(row.userId);
        await this.provider.cancel({ token: scope.token, teamId: scope.teamId }, row.vercelDeploymentId);
      } catch (error) {
        if (error instanceof ProviderError && error.invalidToken) await this.credentials.markInvalid(row.userId);
      }
    }
    return toView(await this.markFinished(row, "cancelled", "Cancelled by user."));
  }

  /**
   * On startup: a deploy Vercel already has is polled again; one that never
   * reached Vercel cannot continue (its GitHub token was only in memory).
   */
  async resumeAll(): Promise<{ resumed: number; failed: number }> {
    const rows = await this.db.vercelDeployment.findMany({
      where: { state: { notIn: ["live", "failed", "cancelled"] } },
      orderBy: { createdAt: "asc" },
    });
    let resumed = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.vercelDeploymentId) {
        this.queue.add({ deploymentId: row.deploymentId, componentId: row.componentId });
        resumed++;
      } else {
        await this.markFinished(
          row,
          "failed",
          "Interrupted by a restart of the Vercel integration service before the deploy reached Vercel. Deploy again.",
        );
        failed++;
      }
    }
    return { resumed, failed };
  }

  /** Phase 9 hook: writes env vars to the component's Vercel project. */
  async setEnv(userId: string, componentId: string, vars: EnvVarInput[]): Promise<{ updated: number }> {
    const project = await this.ownedProject(userId, componentId);
    const scope = await this.credentials.getToken(userId);
    await this.provider.setEnv({ token: scope.token, teamId: project.teamId }, project.vercelProjectId, vars);
    return { updated: vars.length };
  }

  /** Deletes the component's Vercel project. Not called automatically in the MVP. */
  async destroyProject(userId: string, componentId: string): Promise<{ deleted: boolean }> {
    const project = await this.db.vercelProject.findUnique({ where: { componentId } });
    if (!project) return { deleted: false };
    if (project.userId !== userId) throw notFound(`Component ${componentId} has no Vercel project.`);
    const scope = await this.credentials.getToken(userId);
    await this.provider.destroy({ token: scope.token, teamId: project.teamId }, project.vercelProjectId);
    await this.db.vercelProject.delete({ where: { componentId } });
    return { deleted: true };
  }

  private async ownedProject(userId: string, componentId: string) {
    const project = await this.db.vercelProject.findUnique({ where: { componentId } });
    if (!project || project.userId !== userId) {
      throw badRequest("Deploy this component to Vercel once before setting its environment variables.");
    }
    return project;
  }

  private async markFinished(
    row: VercelDeployment,
    state: "failed" | "cancelled",
    errorMessage: string,
  ): Promise<VercelDeployment> {
    const updated = await this.db.vercelDeployment.update({
      where: { deploymentId: row.deploymentId },
      data: { state, errorMessage, finishedAt: new Date() },
    });
    this.outbox.push(row.deploymentId, { type: "status", providerStatus: state, errorMessage });
    this.outbox.push(row.deploymentId, { type: "terminal", status: state, errorMessage });
    void this.outbox.drain(row.deploymentId);
    return updated;
  }
}

export function toView(row: VercelDeployment): DeploymentView {
  return {
    deploymentId: row.deploymentId,
    componentId: row.componentId,
    state: row.state,
    vercelDeploymentId: row.vercelDeploymentId,
    sourceMode: row.sourceMode,
    url: row.url,
    inspectorUrl: row.inspectorUrl,
    productionUrl: row.productionUrl,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
