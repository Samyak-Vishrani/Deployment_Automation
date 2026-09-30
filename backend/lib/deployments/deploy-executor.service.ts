import { join, resolve, sep } from "node:path";
import type { Deployment, PrismaClient, Project } from "@prisma/client";
import { removeDir } from "@/lib/common/fs-utils";
import { CommandAbortedError, CommandFailedError, run } from "@/lib/common/spawn";
import { MANAGED_LABEL, type DockerService } from "@/lib/docker/docker.service";
import type { EventsService } from "@/lib/events/events.service";
import type { GithubAppService } from "@/lib/github/github-app.service";
import { downloadSource } from "@/lib/github/source-archive";
import {
  resolveDataDir,
  type DeploymentLogsService,
  type DeploymentLogWriter,
} from "./deployment-logs.service";
import type { QueueJob } from "./deployment-queue";

const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Runs one deployment: obtain an image, then replace the container.
 *
 * Ordering is deliberate. The image is ready BEFORE the running container is
 * touched, so a failed build leaves the previous version serving untouched.
 * Only once there is a working image do we stop the old one.
 */
export class DeployExecutor {
  private readonly dataDir = resolveDataDir();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly github: GithubAppService,
    private readonly docker: DockerService,
    private readonly logs: DeploymentLogsService,
    private readonly events: EventsService,
  ) {}

  async run(job: QueueJob, signal: AbortSignal): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: job.deploymentId },
      include: { project: true },
    });
    if (!deployment) {
      console.warn(`[deploy] Deployment ${job.deploymentId} vanished before it ran.`);
      return;
    }

    const project = deployment.project;
    const workDir = join(this.dataDir, "work", deployment.id);
    const slug = project.slug ?? project.id;
    const containerName = `orbitops-${slug}`;
    const imagePrefix = `orbitops-${slug}`;

    const writer = await this.logs.open(project.id, deployment.id);

    await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: { status: "running", startedAt: new Date() },
    });
    this.events.deploymentChanged(project.id, deployment.id, "running");

    let imageTag: string | undefined;
    let previousImage: string | undefined;

    try {
      writer.section(
        `Deploying ${slug} (${project.repoFullName ?? "unknown repo"}@${deployment.branch})`,
      );

      if (!(await this.docker.isAvailable())) {
        throw new Error("Docker is not reachable. Is Docker Desktop running?");
      }

      // A rollback reuses an image already on disk, skipping the fetch and the
      // build entirely. That is exactly why a successful deploy prunes to the
      // last few tags rather than to one.
      if (deployment.trigger === "rollback") {
        imageTag = deployment.imageTag ?? undefined;
        if (!imageTag) {
          throw new Error("Rollback deployment has no image tag recorded.");
        }
        writer.section(`Rolling back to ${imageTag} (no rebuild)`);
      } else {
        imageTag = await this.fetchAndBuild(
          deployment,
          project,
          writer,
          workDir,
          imagePrefix,
          signal,
        );
      }

      // --------------------------------------------------------- release ----
      this.throwIfAborted(signal);
      const hostPort = project.hostPort!;
      writer.section(`Starting container on 127.0.0.1:${hostPort}`);

      const result = await this.docker.replaceContainer({
        name: containerName,
        image: imageTag,
        containerPort: project.containerPort,
        hostPort,
        env: (project.envVars as Record<string, string>) ?? {},
        projectId: project.id,
        deploymentId: deployment.id,
      });
      previousImage = result.previousImage;

      const health = await this.docker.waitUntilHealthy(containerName);
      if (!health.ok) {
        const tail = await this.docker.containerLogs(containerName);
        if (tail) {
          writer.section("Container output");
          for (const line of tail.split("\n")) writer.write(line);
        }
        throw new Error(`Container failed to start: ${health.reason}`);
      }

      writer.section(`Deployed. http://localhost:${hostPort}`);

      // Swapping rather than overwriting is what makes rollback repeatable:
      // rolling back twice returns to where you started.
      await this.prisma.project.update({
        where: { id: project.id },
        data: {
          containerId: result.id,
          previousImageTag: project.currentImageTag,
          currentImageTag: imageTag,
        },
      });

      await this.finish(deployment, writer, "success", imageTag);
      // Only after a success, and only down to the last few tags - that is what
      // keeps a rollback target on disk.
      await this.docker.pruneImages(imagePrefix);
    } catch (error) {
      await this.handleFailure(
        deployment,
        project,
        containerName,
        writer,
        error,
        previousImage,
        imageTag,
      );
    } finally {
      await removeDir(workDir).catch((e) =>
        console.warn(`[deploy] Could not clean ${workDir}: ${(e as Error).message}`),
      );
    }
  }

  /** Downloads the source at the exact commit and builds an image from it. */
  private async fetchAndBuild(
    deployment: Deployment,
    project: Project,
    writer: DeploymentLogWriter,
    workDir: string,
    imagePrefix: string,
    signal: AbortSignal,
  ): Promise<string> {
    // ------------------------------------------------------------ source ----
    this.throwIfAborted(signal);
    writer.section("Fetching source");

    const ref = deployment.commitSha ?? deployment.branch;

    const repo = {
      owner: project.owner!,
      repo: project.repo!,
      fullName: project.repoFullName!,
    };
    const installationId =
      project.installationId ?? (await this.github.resolveInstallationId(repo));

    // The installation token is a live credential. Registering it with the log
    // writer means every subsequent line is scrubbed of it before being written
    // or streamed, whichever child process produced it.
    const token = await this.github.getInstallationToken(installationId);
    writer.addSecret(token);

    await downloadSource(this.github, repo, ref, installationId, workDir);
    writer.write(`Source for ${repo.fullName}@${ref.slice(0, 12)} extracted.`);

    // ------------------------------------------------------------- build ----
    this.throwIfAborted(signal);

    // Tagging by commit sha is what removes the need for Dokploy's Swarm
    // ForceUpdate+1 trick: every build produces a genuinely new tag, so there
    // is never any question of whether the runtime picked up new code.
    const shortSha = (deployment.commitSha ?? Date.now().toString(36)).slice(0, 7);
    const imageTag = `${imagePrefix}:${shortSha}`;

    const contextDir = this.safeJoin(workDir, project.buildContext);
    const dockerfile = this.safeJoin(workDir, project.dockerfilePath);

    writer.section(`Building ${imageTag}`);
    await run(
      "docker",
      [
        "build",
        "--file", dockerfile,
        "--tag", imageTag,
        "--tag", `${imagePrefix}:latest`,
        "--label", `${MANAGED_LABEL}=true`,
        "--label", `orbitops.project=${project.id}`,
        "--label", `orbitops.deployment=${deployment.id}`,
        "--progress", "plain",
        contextDir,
      ],
      { onLine: (line) => writer.write(line), signal, timeoutMs: BUILD_TIMEOUT_MS },
    );

    return imageTag;
  }

  private async handleFailure(
    deployment: Deployment,
    project: Project,
    containerName: string,
    writer: DeploymentLogWriter,
    error: unknown,
    previousImage: string | undefined,
    imageTag: string | undefined,
  ): Promise<void> {
    const cancelled = error instanceof CommandAbortedError;
    const message = cancelled
      ? "Deployment cancelled."
      : error instanceof CommandFailedError
        ? `${error.command} exited with code ${error.code}`
        : (error as Error).message;

    writer.section(cancelled ? "Cancelled" : `Failed: ${message}`);

    // Rollback only makes sense if a working container was actually replaced.
    if (!cancelled && previousImage && previousImage !== imageTag) {
      writer.section(`Rolling back to ${previousImage}`);
      try {
        await this.docker.replaceContainer({
          name: containerName,
          image: previousImage,
          containerPort: project.containerPort,
          hostPort: project.hostPort!,
          env: (project.envVars as Record<string, string>) ?? {},
          projectId: project.id,
          deploymentId: deployment.id,
        });
        writer.write(`Rolled back. http://localhost:${project.hostPort}`);
      } catch (rollbackError) {
        writer.write(`Rollback failed: ${(rollbackError as Error).message}`);
      }
    } else if (!cancelled && !previousImage) {
      writer.write("No previous image to roll back to; the port is left free.");
    }

    await this.finish(deployment, writer, cancelled ? "cancelled" : "failed", imageTag, message);
  }

  private async finish(
    deployment: Deployment,
    writer: DeploymentLogWriter,
    status: "success" | "failed" | "cancelled",
    imageTag?: string,
    errorMessage?: string,
  ): Promise<void> {
    await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status,
        finishedAt: new Date(),
        imageTag: imageTag ?? null,
        errorMessage: errorMessage ?? null,
        logTail: writer.tailText(),
      },
    });
    await writer.close(status);
    this.events.deploymentChanged(deployment.projectId, deployment.id, status);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new CommandAbortedError("deployment");
    }
  }

  /**
   * Joins a repository-supplied relative path onto the workspace, refusing to
   * escape it. dockerfilePath and buildContext are user input, and "../.."
   * would otherwise reach arbitrary files on the host.
   */
  private safeJoin(base: string, relative: string): string {
    const target = resolve(base, relative);
    const normalisedBase = resolve(base);
    if (target !== normalisedBase && !target.startsWith(normalisedBase + sep)) {
      throw new Error(`Path "${relative}" escapes the build workspace.`);
    }
    return target;
  }
}
