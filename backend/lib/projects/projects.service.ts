import { Prisma, type PrismaClient, type Project } from "@prisma/client";
import { badRequest, conflict, notFound } from "@/lib/api/http-error";
import type { DockerService } from "@/lib/docker/docker.service";
import type { EventsService } from "@/lib/events/events.service";
import type { GithubAppService } from "@/lib/github/github-app.service";
import { InvalidRepoUrlError, parseRepoUrl } from "@/lib/github/repo-url";
import type { CreateProjectInput, UpdateProjectInput } from "./project-input";
import { createWithAllocatedPort, readPortRange } from "./port-allocator";

/**
 * A project as returned by the API.
 *
 * `envVars` is reduced to its KEYS. The values are frequently secrets, and a
 * list endpoint is the easiest place to leak them by accident.
 */
export type ProjectView = Omit<Project, "envVars"> & { envKeys: string[] };

export class ProjectsService {
  private readonly portRange = readPortRange();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly github: GithubAppService,
    private readonly docker: DockerService,
    private readonly events: EventsService,
  ) {}

  toView(project: Project): ProjectView {
    const { envVars, ...rest } = project;
    return {
      ...rest,
      envKeys: Object.keys((envVars as Record<string, string>) ?? {}),
    };
  }

  async create(userId: string, dto: CreateProjectInput): Promise<ProjectView> {
    let repo;
    try {
      repo = parseRepoUrl(dto.repoUrl);
    } catch (error) {
      if (error instanceof InvalidRepoUrlError) {
        throw badRequest(error.message);
      }
      throw error;
    }

    // Resolves the numeric repo id, which is what pushes are matched on, and
    // proves the App can actually see the repository before we store anything.
    const metadata = await this.github.getRepoMetadata(repo);
    const branch = dto.branch?.trim() || metadata.defaultBranch;

    if (dto.branch && !(await this.github.branchExists(repo, branch))) {
      throw badRequest(`Branch "${branch}" does not exist on ${metadata.fullName}.`);
    }

    const slug = dto.slug?.trim() || this.slugify(metadata.repo);
    const name = dto.name?.trim() || metadata.repo;

    try {
      const project = await this.prisma.$transaction((tx) =>
        createWithAllocatedPort(tx, this.portRange, (hostPort) =>
          tx.project.create({
            data: {
              userId,
              name,
              slug,
              // Written in both vocabularies on purpose: the analysis phase
              // reads github*, the push pipeline reads repo*/owner/repo. One
              // create keeps a project usable by both without either phase
              // having to know about the other.
              githubRepoId: String(metadata.id),
              githubFullName: metadata.fullName,
              githubUrl: `https://github.com/${metadata.fullName}`,
              defaultBranch: metadata.defaultBranch,
              repoId: metadata.id,
              repoFullName: metadata.fullName,
              owner: metadata.owner,
              repo: metadata.repo,
              branch,
              autoDeploy: dto.autoDeploy ?? true,
              installationId: metadata.installationId,
              watchPaths: dto.watchPaths ?? [],
              dockerfilePath: dto.dockerfilePath?.trim() || "Dockerfile",
              buildContext: dto.buildContext?.trim() || ".",
              envVars: (dto.envVars ?? {}) as Prisma.InputJsonValue,
              containerPort: dto.containerPort ?? 3000,
              hostPort,
            },
          }),
        ),
      );

      console.log(
        `[projects] Created ${project.slug} -> ${project.repoFullName}@${project.branch} ` +
          `(repoId ${project.repoId}, host port ${project.hostPort}).`,
      );
      this.events.projectChanged(project.id, "created");
      return this.toView(project);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // hostPort is allocated under an advisory lock and cannot realistically
        // collide, so the reachable conflicts are the slug and the
        // (userId, githubFullName) pair.
        const target = (error.meta?.target as string[] | undefined) ?? [];
        if (target.includes("githubFullName")) {
          throw conflict(
            `You already have a project for ${metadata.fullName}. Open it instead of creating a second one.`,
          );
        }
        throw conflict(`A project with the slug "${slug}" already exists. Pass a different "slug".`);
      }
      throw error;
    }
  }

  async findAll(userId: string): Promise<ProjectView[]> {
    const projects = await this.prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return projects.map((p) => this.toView(p));
  }

  async findOne(userId: string, id: string): Promise<ProjectView> {
    return this.toView(await this.getOrThrow(userId, id));
  }

  async update(userId: string, id: string, dto: UpdateProjectInput): Promise<ProjectView> {
    const existing = await this.getOrThrow(userId, id);

    if (dto.branch && dto.branch !== existing.branch) {
      if (!existing.owner || !existing.repo || !existing.repoFullName) {
        throw badRequest(
          `${existing.name} has no GitHub repository attached, so its branch cannot be validated.`,
        );
      }
      const repo = {
        owner: existing.owner,
        repo: existing.repo,
        fullName: existing.repoFullName,
      };
      if (!(await this.github.branchExists(repo, dto.branch))) {
        throw badRequest(`Branch "${dto.branch}" does not exist on ${existing.repoFullName}.`);
      }
    }

    const updated = await this.prisma.project.update({
      where: { id },
      data: {
        ...(dto.branch !== undefined && { branch: dto.branch }),
        ...(dto.autoDeploy !== undefined && { autoDeploy: dto.autoDeploy }),
        ...(dto.watchPaths !== undefined && { watchPaths: dto.watchPaths }),
        ...(dto.dockerfilePath !== undefined && { dockerfilePath: dto.dockerfilePath }),
        ...(dto.buildContext !== undefined && { buildContext: dto.buildContext }),
        ...(dto.envVars !== undefined && { envVars: dto.envVars as Prisma.InputJsonValue }),
        ...(dto.containerPort !== undefined && { containerPort: dto.containerPort }),
      },
    });
    this.events.projectChanged(id, "updated");
    return this.toView(updated);
  }

  /**
   * Deletes the project and, by cascade, its deployments and components.
   *
   * Nothing is done on GitHub: the App's webhook is App-level, so there is no
   * per-repository hook to remove.
   */
  async remove(userId: string, id: string): Promise<{ deleted: true; id: string }> {
    const project = await this.getOrThrow(userId, id);

    // Stop the container first. If the row went first and this then failed, the
    // container would be orphaned AND still holding the host port, with nothing
    // left in the database pointing at it.
    if (project.slug) {
      await this.docker
        .stopProjectContainer(project.id, `orbitops-${project.slug}`)
        .catch((error) =>
          console.warn(
            `[projects] Could not remove the container for ${project.slug}: ${(error as Error).message}`,
          ),
        );
    }

    await this.prisma.project.delete({ where: { id } });
    this.events.projectChanged(id, "deleted");
    console.log(`[projects] Deleted project ${id}.`);
    return { deleted: true, id };
  }

  private async getOrThrow(userId: string, id: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      // Deliberately the same answer for "does not exist" and "belongs to
      // someone else": telling them apart turns this into a project-id oracle.
      throw notFound(`Project ${id} not found.`);
    }
    return project;
  }

  private slugify(value: string): string {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);
    return slug || "project";
  }
}
