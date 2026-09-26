import { Prisma, type Deployment, type DeploymentTrigger, type PrismaClient, type Project } from "@prisma/client";
import { badRequest, notFound } from "@/lib/api/http-error";
import type { EventsService } from "@/lib/events/events.service";
import type { DeploymentQueue } from "./deployment-queue";
import { changedFiles, commitInfo, screenPush, shouldDeploy } from "./push-filter";
import type { PushPayload } from "./push-payload";

export interface HandlePushResult {
  matched: number;
  queued: number;
  skipped: string;
}

/**
 * Turns a verified push into queued Deployment rows.
 *
 * This is the piece that mirrors Dokploy's decision pipeline: cheap payload
 * gates first, then one indexed lookup that fans out to every project watching
 * the repository and branch, then the per-project watch-path filter that SQL
 * cannot express.
 */
export class DeploymentsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: DeploymentQueue,
    private readonly events: EventsService,
  ) {}

  async handlePush(payload: PushPayload, deliveryId?: string): Promise<HandlePushResult> {
    const screened = screenPush(payload);
    if (!screened.deployable) {
      console.debug(`[push] Ignored: ${screened.reason}.`);
      return { matched: 0, queued: 0, skipped: screened.reason };
    }

    const { branch, repoId } = screened;

    // The decision. Dokploy expresses this as a seven-clause compound WHERE;
    // keying on the numeric repoId reduces it to three, and the compound index
    // on (autoDeploy, repoId, branch) makes it a single scan. findMany, not
    // findFirst: one push legitimately fans out to several projects.
    const projects = await this.prisma.project.findMany({
      where: { autoDeploy: true, repoId, branch },
    });

    if (projects.length === 0) {
      // Entirely normal - most pushes to an installed App match nothing. Debug
      // level, because at warn this would drown the log once the App is
      // installed across an organisation.
      console.debug(
        `[push] No project matches repoId ${repoId} on branch ${branch} ` +
          `(${payload.repository?.full_name ?? "unknown repo"}).`,
      );
      return { matched: 0, queued: 0, skipped: "no-matching-projects" };
    }

    const files = changedFiles(payload);
    const info = commitInfo(payload);
    let queued = 0;

    for (const project of projects) {
      if (!shouldDeploy(project.watchPaths, files)) {
        console.debug(
          `[push] Project ${project.slug ?? project.id}: no changed file matched watchPaths, skipping.`,
        );
        continue;
      }

      const deployment = await this.enqueue(project, {
        trigger: "push",
        branch,
        deliveryId: deliveryId ?? null,
        ...info,
      });

      if (deployment) {
        queued++;
      }

      // A repository rename or transfer changes repoFullName but not repoId,
      // so the push we just matched is the moment to heal the stale display
      // value. Cheap, and it keeps the UI honest.
      const freshFullName = payload.repository?.full_name;
      if (freshFullName && freshFullName !== project.repoFullName) {
        await this.prisma.project.update({
          where: { id: project.id },
          data: {
            repoFullName: freshFullName,
            // githubFullName is the column the analysis phase reads, so it is
            // healed in the same write rather than being left to drift.
            githubFullName: freshFullName,
            owner: payload.repository?.owner?.login ?? project.owner,
            repo: payload.repository?.name ?? project.repo,
          },
        });
        console.log(
          `[push] Project ${project.slug ?? project.id} repository renamed: ` +
            `${project.repoFullName} -> ${freshFullName}.`,
        );
      }
    }

    return { matched: projects.length, queued, skipped: "" };
  }

  /** Manual deploy of a project's current branch head. */
  async deployManually(projectId: string): Promise<Deployment> {
    const project = await this.getDeployableProject(projectId);

    const deployment = await this.enqueue(project, {
      trigger: "manual",
      branch: project.branch!,
      deliveryId: null,
      commitSha: null,
      commitMessage: "Manual deployment",
      commitAuthor: null,
    });

    // deliveryId is null for manual deploys, and Postgres treats NULLs as
    // distinct, so the unique constraint never blocks one.
    return deployment!;
  }

  async findOne(id: string): Promise<Deployment> {
    const deployment = await this.prisma.deployment.findUnique({ where: { id } });
    if (!deployment) {
      throw notFound(`Deployment ${id} not found.`);
    }
    return deployment;
  }

  /**
   * Redeploys the image the project was running before its current one.
   *
   * With plain containers there is no Swarm rollback to ask for, so "rollback"
   * means starting the previous image again. No fetch and no build: the image
   * is already on disk, which is also why a successful deploy prunes to the
   * last few tags rather than to one.
   */
  async rollback(projectId: string): Promise<Deployment> {
    const project = await this.getDeployableProject(projectId);
    if (!project.previousImageTag) {
      throw badRequest(
        `${project.name} has no previous image to roll back to. It needs at least two successful deployments.`,
      );
    }

    const deployment = await this.enqueue(project, {
      trigger: "rollback",
      branch: project.branch!,
      deliveryId: null,
      commitSha: null,
      commitMessage: `Rollback to ${project.previousImageTag}`,
      commitAuthor: null,
      imageTag: project.previousImageTag,
    });
    return deployment!;
  }

  /**
   * Cancels a queued or running deployment.
   *
   * The queue owns cancellation of live work (it holds the AbortController);
   * the row is only marked here if the job was never picked up, since the
   * executor writes its own terminal state when an abort interrupts it.
   */
  async cancel(id: string): Promise<{ status: string }> {
    const deployment = await this.findOne(id);
    if (!["queued", "running"].includes(deployment.status)) {
      return { status: `already ${deployment.status}` };
    }

    const result = this.queue.cancel(id);
    if (result === "not-found") {
      await this.prisma.deployment.update({
        where: { id },
        data: {
          status: "cancelled",
          errorMessage: "Cancelled before it started.",
          finishedAt: new Date(),
        },
      });
    }
    return { status: "cancelled" };
  }

  async listForProject(projectId: string, take = 50): Promise<Deployment[]> {
    return this.prisma.deployment.findMany({
      where: { projectId },
      orderBy: { queuedAt: "desc" },
      take,
    });
  }

  /**
   * A project that can actually be built and run.
   *
   * The deploy columns are nullable so that a project created purely for
   * repository analysis is still a valid row. Deploying one of those is a
   * user-facing mistake, not a 500, so it is caught here with the fix in the
   * message.
   */
  private async getDeployableProject(projectId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw notFound(`Project ${projectId} not found.`);
    }
    if (!project.slug || !project.branch || project.hostPort === null || !project.repoFullName) {
      throw badRequest(
        `${project.name} is not configured for deployment. It was created for repository analysis only; ` +
          "recreate it from the deploy screen so it gets a slug, a branch and a host port.",
      );
    }
    return project;
  }

  /**
   * Creates the queued row. Returns null when this delivery already produced a
   * deployment for this project, which is how a GitHub redelivery arriving
   * after a restart - when the in-memory DeliveryStore is empty - is absorbed.
   */
  private async enqueue(
    project: Project,
    data: {
      trigger: DeploymentTrigger;
      branch: string;
      deliveryId: string | null;
      commitSha: string | null;
      commitMessage: string | null;
      commitAuthor: string | null;
      /** Set only for a rollback, which reuses an image instead of building. */
      imageTag?: string;
    },
  ): Promise<Deployment | null> {
    try {
      const deployment = await this.prisma.deployment.create({
        data: { projectId: project.id, status: "queued", ...data },
      });
      console.log(
        `[deploy] Queued deployment ${deployment.id} for ${project.slug ?? project.id} ` +
          `(${data.branch}${data.commitSha ? ` @ ${data.commitSha.slice(0, 7)}` : ""}).`,
      );
      // The row exists first, then the job. That order is what lets a restart
      // rebuild the backlog from the database - see lib/runtime.ts.
      this.queue.add({ deploymentId: deployment.id, projectId: project.id });
      this.events.deploymentChanged(project.id, deployment.id, "queued");
      return deployment;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        console.log(
          `[deploy] Delivery ${data.deliveryId} already deployed for ${project.slug ?? project.id}; ignoring redelivery.`,
        );
        return null;
      }
      throw error;
    }
  }
}
