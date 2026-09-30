/**
 * Analysis orchestration service.
 *
 * Coordinates between:
 * - Prisma (project ownership, persisting analysis snapshots)
 * - GithubAppService (installation token, the commit a branch points at)
 * - GitHub service (fetching tree + file contents)
 * - Detection engine (analyzing the tree)
 */

import { join } from "node:path";
import type { Analysis, Prisma, PrismaClient, Project, ProjectComponent } from "@prisma/client";
import { HttpError } from "@/lib/api/http-error";
import { removeDir } from "@/lib/common/fs-utils";
import { redact } from "@/lib/common/redact";
import { resolveDataDir } from "@/lib/deployments/deployment-logs.service";
import { GithubError, type GithubAppService } from "@/lib/github/github-app.service";
import { getFileContent, getRepositoryTree, GitHubApiError } from "@/lib/github/github.service";
import type { ParsedRepo } from "@/lib/github/repo-url";
import { downloadSource, readSourceFile, walkSourceTree } from "@/lib/github/source-archive";
import type { DatabaseHint } from "./database-hints";
import {
  detectComponents,
  type AnalysisWarning,
  type DetectionResult,
} from "./detection.service";

/** Snapshots kept per project. Older ones, and their components, are deleted. */
const KEEP_ANALYSES = 5;
/** A run still "running" after this long belongs to a process that died. */
const STALE_RUNNING_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AnalysisSource = "tree" | "tarball";

export type AnalysisResult = {
  projectId: string;
  projectName: string;
  repository: string;
  /** NULL when the project has never been analysed successfully. */
  analysisId: string | null;
  branch: string | null;
  commitSha: string | null;
  source: AnalysisSource | null;
  /** ISO timestamp, or "" when there is no analysis yet. */
  analyzedAt: string;
  /** True when an existing snapshot of the same commit was returned. */
  reused: boolean;
  warnings: AnalysisWarning[];
  database: DatabaseHint | null;
  components: PersistedComponent[];
};

export type PersistedComponent = {
  id: string;
  type: string;
  role: string | null;
  framework: string | null;
  language: string | null;
  path: string | null;
  packageManager: string | null;
  detectedVersion: string | null;
  confidence: number | null;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  outputDir: string | null;
  runtimeVersion: string | null;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
};

type AnalysisWithComponents = Analysis & { components: ProjectComponent[] };

const withComponents = {
  components: { orderBy: [{ path: "asc" }, { id: "asc" }] },
} satisfies Prisma.AnalysisInclude;

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AnalysisService {
  private readonly dataDir = resolveDataDir();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly github: GithubAppService,
  ) {}

  /**
   * Runs a full analysis for a project:
   * 1. Verifies project ownership.
   * 2. Resolves the commit the project's branch points at.
   * 3. Returns the existing snapshot of that commit, unless `force`.
   * 4. Fetches the tree at that commit and runs the detection engine.
   * 5. Stores the result as a new snapshot and prunes old ones.
   */
  async analyze(
    userId: string,
    projectId: string,
    options: { force?: boolean } = {},
  ): Promise<AnalysisResult> {
    const project = await this.getOrThrow(userId, projectId);
    const repo = this.repoOf(project);
    const branch = project.branch ?? project.defaultBranch;
    if (!branch) {
      throw new HttpError(
        `${project.name} has no branch to analyse.`,
        400,
        "github_not_connected",
      );
    }

    let analysisId: string | undefined;
    // Authenticates as the GitHub App installation, exactly as the deploy
    // executor does. GitHub sign-in deliberately never stores a user token.
    let token: string | undefined;
    try {
      const installationId =
        project.installationId ?? (await this.github.resolveInstallationId(repo));
      // Every read below is pinned to this SHA, so a push landing mid-analysis
      // cannot leave us with the tree of one commit and the files of another.
      const commitSha = await this.github.getBranchHeadSha(repo, branch, installationId);

      if (!options.force) {
        const existing = await this.prisma.analysis.findFirst({
          where: { projectId, branch, commitSha, status: "succeeded" },
          orderBy: { createdAt: "desc" },
          include: withComponents,
        });
        if (existing) {
          return this.toResult(project, existing, true);
        }
      }

      await this.prisma.analysis.updateMany({
        where: {
          projectId,
          status: "running",
          createdAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) },
        },
        data: {
          status: "failed",
          error: "Interrupted before it finished.",
          finishedAt: new Date(),
        },
      });

      const analysis = await this.prisma.analysis.create({
        data: { projectId, branch, commitSha, source: "tree" },
      });
      analysisId = analysis.id;

      token = await this.github.getInstallationToken(installationId);
      const detected = await this.inspect(analysis.id, repo, commitSha, installationId, token);
      const saved = await this.persist(projectId, analysis.id, detected);
      return this.toResult(project, saved, false);
    } catch (error) {
      const failure = this.toHttpError(error, repo.fullName, token);
      if (analysisId) {
        await this.recordFailure(projectId, analysisId, failure.message);
      }
      throw failure;
    }
  }

  /** Returns the latest successful analysis for a project. */
  async getLatest(userId: string, projectId: string): Promise<AnalysisResult> {
    const project = await this.getOrThrow(userId, projectId);
    const latest = await this.prisma.analysis.findFirst({
      where: { projectId, status: "succeeded" },
      orderBy: { createdAt: "desc" },
      include: withComponents,
    });
    return this.toResult(project, latest, false);
  }

  // ------------------------------------------------------------- internals --

  /**
   * Reads the repository at one commit and runs detection over it.
   *
   * The tree API plus a handful of file reads is the fast path. It stops
   * listing entries on very large repositories, and analysing a partial tree
   * would silently miss components, so a truncated tree falls back to
   * downloading the source and reading it from disk.
   */
  private async inspect(
    analysisId: string,
    repo: ParsedRepo,
    commitSha: string,
    installationId: string,
    token: string,
  ): Promise<DetectionResult & { source: AnalysisSource }> {
    const tree = await getRepositoryTree(repo.fullName, commitSha, token);
    if (!tree.truncated) {
      const result = await detectComponents(tree.tree, (path) =>
        getFileContent(repo.fullName, path, commitSha, token),
      );
      return { ...result, source: "tree" };
    }

    const workDir = join(this.dataDir, "analysis", analysisId);
    try {
      await downloadSource(this.github, repo, commitSha, installationId, workDir);
      const entries = await walkSourceTree(workDir);
      const result = await detectComponents(entries, (path) => readSourceFile(workDir, path));
      return {
        ...result,
        warnings: [
          {
            code: "tree_truncated",
            message:
              "The repository is too large for the GitHub tree API, so it was analysed from a source download instead.",
          },
          ...result.warnings,
        ],
        source: "tarball",
      };
    } finally {
      await removeDir(workDir).catch((e) =>
        console.warn(`[analysis] Could not clean ${workDir}: ${(e as Error).message}`),
      );
    }
  }

  private persist(
    projectId: string,
    analysisId: string,
    detected: DetectionResult & { source: AnalysisSource },
  ): Promise<AnalysisWithComponents> {
    return this.prisma.$transaction(async (tx) => {
      if (detected.components.length > 0) {
        // Clipped to the column widths: every one of these strings is derived
        // from repository content, and an oversized value must not fail the run.
        await tx.projectComponent.createMany({
          data: detected.components.map((comp) => ({
            projectId,
            analysisId,
            type: comp.type,
            role: comp.role,
            framework: clip(comp.framework, 100),
            language: clip(comp.language, 100),
            path: clip(comp.path, 500),
            packageManager: clip(comp.packageManager, 50),
            detectedVersion: clip(comp.detectedVersion, 100),
            confidence: comp.confidence,
            installCmd: comp.installCmd,
            buildCmd: comp.buildCmd,
            startCmd: comp.startCmd,
            outputDir: clip(comp.outputDir, 500),
            runtimeVersion: clip(comp.runtimeVersion, 100),
            evidence: comp.evidence,
          })),
        });
      }

      const saved = await tx.analysis.update({
        where: { id: analysisId },
        data: {
          status: "succeeded",
          source: detected.source,
          warnings: detected.warnings as unknown as Prisma.InputJsonValue,
          database: detected.database as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
        include: withComponents,
      });

      // Keep the last few successful snapshots; everything else that is not
      // in flight goes, and the cascade takes its components with it.
      const keep = await tx.analysis.findMany({
        where: { projectId, status: "succeeded" },
        orderBy: { createdAt: "desc" },
        take: KEEP_ANALYSES,
        select: { id: true },
      });
      await tx.analysis.deleteMany({
        where: {
          projectId,
          status: { not: "running" },
          id: { notIn: keep.map((row) => row.id) },
        },
      });

      return saved;
    });
  }

  /** Best effort: the caller is already on its way to reporting the real error. */
  private async recordFailure(projectId: string, analysisId: string, message: string): Promise<void> {
    try {
      await this.prisma.analysis.update({
        where: { id: analysisId },
        data: { status: "failed", error: message, finishedAt: new Date() },
      });
      // Only the most recent failure is worth keeping.
      await this.prisma.analysis.deleteMany({
        where: { projectId, status: "failed", id: { not: analysisId } },
      });
    } catch (error) {
      console.warn(`[analysis] Could not record the failure of ${analysisId}: ${(error as Error).message}`);
    }
  }

  private toHttpError(error: unknown, repository: string, token?: string): HttpError {
    if (error instanceof HttpError) {
      return error;
    }
    if (error instanceof GitHubApiError) {
      if (error.status === 404) {
        return new HttpError(
          `Repository "${repository}" not found or inaccessible.`,
          404,
          "repo_not_found",
        );
      }
      return new HttpError(
        redact(`GitHub API error: ${error.message}`, [token]),
        502,
        "github_api_error",
      );
    }
    if (error instanceof GithubError) {
      // Already credential-free, with a status chosen for the frontend.
      return new HttpError(
        error.message,
        error.status,
        error.status === 404 ? "repo_not_found" : "github_api_error",
      );
    }
    console.error("[analysis] Analysis engine failed:", error);
    return new HttpError("Analysis engine failed.", 500, "analysis_failed");
  }

  private repoOf(project: Project): ParsedRepo {
    const fullName = project.repoFullName ?? project.githubFullName;
    const [owner, repo] =
      project.owner && project.repo ? [project.owner, project.repo] : (fullName ?? "").split("/");
    if (!fullName || !owner || !repo) {
      throw new HttpError(
        "No GitHub repository connected to this project.",
        400,
        "github_not_connected",
      );
    }
    return { owner, repo, fullName };
  }

  private async getOrThrow(userId: string, projectId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== userId) {
      // The same answer for "does not exist" and "belongs to someone else",
      // as ProjectsService does: telling them apart is a project-id oracle.
      throw new HttpError("Project not found.", 404, "project_not_found");
    }
    return project;
  }

  private toResult(
    project: Project,
    analysis: AnalysisWithComponents | null,
    reused: boolean,
  ): AnalysisResult {
    return {
      projectId: project.id,
      projectName: project.name,
      repository: project.repoFullName ?? project.githubFullName ?? "",
      analysisId: analysis?.id ?? null,
      branch: analysis?.branch ?? null,
      commitSha: analysis?.commitSha ?? null,
      source: (analysis?.source as AnalysisSource | undefined) ?? null,
      analyzedAt: (analysis?.finishedAt ?? analysis?.createdAt)?.toISOString() ?? "",
      reused,
      warnings: (analysis?.warnings as AnalysisWarning[] | undefined) ?? [],
      database: (analysis?.database as DatabaseHint | null | undefined) ?? null,
      components: (analysis?.components ?? []).map(toPersistedComponent),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPersistedComponent(row: ProjectComponent): PersistedComponent {
  return {
    id: row.id,
    type: row.type,
    role: row.role,
    framework: row.framework,
    language: row.language,
    path: row.path,
    packageManager: row.packageManager,
    detectedVersion: row.detectedVersion,
    confidence: row.confidence,
    installCmd: row.installCmd,
    buildCmd: row.buildCmd,
    startCmd: row.startCmd,
    outputDir: row.outputDir,
    runtimeVersion: row.runtimeVersion,
    evidence: Array.isArray(row.evidence) ? (row.evidence as string[]) : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
