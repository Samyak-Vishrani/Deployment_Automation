import {
  Prisma,
  type Component,
  type ComponentKind,
  type PrismaClient,
  type Project,
  type ProviderId,
} from "@prisma/client";
import { badRequest, conflict, HttpError, notFound } from "@/lib/api/http-error";
import type { AnalysisResult, AnalysisService } from "@/lib/analysis/analysis.service";
import type { EventsService } from "@/lib/events/events.service";
import { GithubError, type GithubAppService } from "@/lib/github/github-app.service";
import { getFileContent, getRepositoryTree, GitHubApiError } from "@/lib/github/github.service";
import type { ParsedRepo } from "@/lib/github/repo-url";
import { assertValidUpdate, type ComponentInput, type UpdateComponentInput } from "./component-input";
import { runPreflight, type CredentialState, type PreflightDeps, type PreflightResult } from "./preflight";
import { PROVIDER_FOR_KIND } from "./provider-rules";

/**
 * A component the analysis suggests, before the user has confirmed it.
 *
 * `kind` and `provider` are null when the analysis could not tell a frontend
 * from a backend: the configure screen asks the user to pick.
 */
export type ProposedComponent = Omit<ComponentInput, "kind" | "provider"> & {
  kind: ComponentKind | null;
  provider: ProviderId | null;
  /** Why the analysis suggested it, for the card. */
  evidence: string[];
  confidence: number | null;
};

export type ComponentProposal = {
  analysisId: string | null;
  branch: string | null;
  commitSha: string | null;
  analyzedAt: string;
  components: ProposedComponent[];
};

/** Asks for the state of the user's account with a provider (Vercel: via the integration service). */
export type CredentialLookup = (userId: string, provider: ProviderId) => Promise<CredentialState>;

const notConnected: CredentialLookup = async () => "missing";

const ORDER = [{ kind: "asc" }, { rootDir: "asc" }] satisfies Prisma.ComponentOrderByWithRelationInput[];

const keyOf = (c: { kind: ComponentKind; rootDir: string }) => `${c.kind}:${c.rootDir}`;

export class ComponentsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly github: GithubAppService,
    private readonly analysis: AnalysisService,
    private readonly events: EventsService,
    private readonly credentialState: CredentialLookup = notConnected,
  ) {}

  async list(userId: string, projectId: string): Promise<Component[]> {
    await this.getOrThrow(userId, projectId);
    return this.prisma.component.findMany({ where: { projectId }, orderBy: ORDER });
  }

  /**
   * Proposed components from the latest analysis, for the user to edit. Nothing
   * is saved. A project that was never analysed is analysed first.
   */
  async fromAnalysis(userId: string, projectId: string): Promise<ComponentProposal> {
    const project = await this.getOrThrow(userId, projectId);
    let analysis = await this.analysis.getLatest(userId, projectId);
    if (!analysis.analysisId) {
      analysis = await this.analysis.analyze(userId, projectId);
    }
    return {
      analysisId: analysis.analysisId,
      branch: analysis.branch,
      commitSha: analysis.commitSha,
      analyzedAt: analysis.analyzedAt,
      components: proposeComponents(project.repo ?? project.name, analysis),
    };
  }

  /**
   * Saves the confirmed set, matched to existing rows on (kind, rootDir).
   *
   * Matched rows are updated, never re-created, so the provider resource id and
   * URL a later phase stored on them survive an edit. Rows not in the set are
   * deleted.
   */
  async replaceAll(userId: string, projectId: string, inputs: ComponentInput[]): Promise<Component[]> {
    await this.getOrThrow(userId, projectId);

    const saved = await this.prisma.$transaction(async (tx) => {
      const existing = new Map(
        (await tx.component.findMany({ where: { projectId } })).map((c) => [keyOf(c), c]),
      );
      const kept: string[] = [];

      for (const input of inputs) {
        const previous = existing.get(keyOf(input));
        const fields = {
          name: input.name,
          framework: input.framework,
          installCmd: input.installCmd,
          buildCmd: input.buildCmd,
          startCmd: input.startCmd,
          outputDir: input.outputDir,
          nodeVersion: input.nodeVersion,
          provider: input.provider,
          analysisComponentId: input.analysisComponentId ?? previous?.analysisComponentId ?? null,
        };
        const row = previous
          ? await tx.component.update({
              where: { id: previous.id },
              // Only a draft moves to configured: a deploying or live component
              // keeps the status its provider gave it.
              data: { ...fields, ...(previous.status === "draft" && { status: "configured" as const }) },
            })
          : await tx.component.create({
              data: { projectId, kind: input.kind, rootDir: input.rootDir, ...fields, status: "configured" },
            });
        kept.push(row.id);
      }

      await tx.component.deleteMany({ where: { projectId, id: { notIn: kept } } });
      return tx.component.findMany({ where: { projectId }, orderBy: ORDER });
    });

    this.events.projectChanged(projectId, "updated");
    return saved;
  }

  async update(
    userId: string,
    projectId: string,
    componentId: string,
    dto: UpdateComponentInput,
  ): Promise<Component> {
    const component = await this.getComponentOrThrow(userId, projectId, componentId);
    assertValidUpdate(component.kind, { ...component, ...dto });

    try {
      const updated = await this.prisma.component.update({ where: { id: component.id }, data: dto });
      this.events.projectChanged(projectId, "updated");
      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw conflict(`Another ${component.kind} component already uses the folder "${dto.rootDir}".`);
      }
      throw error;
    }
  }

  async remove(
    userId: string,
    projectId: string,
    componentId: string,
  ): Promise<{ deleted: true; id: string }> {
    const component = await this.getComponentOrThrow(userId, projectId, componentId);
    await this.prisma.component.delete({ where: { id: component.id } });
    this.events.projectChanged(projectId, "updated");
    return { deleted: true, id: component.id };
  }

  async preflight(userId: string, projectId: string): Promise<PreflightResult> {
    const project = await this.getOrThrow(userId, projectId);
    const components = await this.prisma.component.findMany({ where: { projectId }, orderBy: ORDER });

    const envVars = (project.envVars ?? {}) as Record<string, unknown>;
    const filledEnvKeys = Object.entries(envVars)
      .filter(([, value]) => typeof value === "string" && value.trim() !== "")
      .map(([key]) => key);

    // Opened at most once, and only if a check needs the repository.
    let opened: Promise<{ fullName: string; sha: string; token: string }> | undefined;
    const open = () => (opened ??= this.openRepo(project));

    const deps: PreflightDeps = {
      listTree: async () => {
        try {
          const { fullName, sha, token } = await open();
          const tree = await getRepositoryTree(fullName, sha, token);
          return { entries: tree.tree, truncated: tree.truncated };
        } catch (error) {
          throw readableGithubError(error);
        }
      },
      readFile: async (path) => {
        const { fullName, sha, token } = await open();
        return getFileContent(fullName, path, sha, token);
      },
      credentialState: this.credentialState,
    };

    return runPreflight({ userId, filledEnvKeys }, components, deps);
  }

  // ------------------------------------------------------------- internals --

  /** The commit the project's branch points at, and a token that can read it. */
  private async openRepo(project: Project): Promise<{ fullName: string; sha: string; token: string }> {
    const repo = repoOf(project);
    const branch = project.branch ?? project.defaultBranch;
    if (!branch) {
      throw badRequest(`${project.name} has no branch to check.`);
    }
    const installationId = project.installationId ?? (await this.github.resolveInstallationId(repo));
    const sha = await this.github.getBranchHeadSha(repo, branch, installationId);
    const token = await this.github.getInstallationToken(installationId);
    return { fullName: repo.fullName, sha, token };
  }

  private async getOrThrow(userId: string, projectId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== userId) {
      // The same answer for "does not exist" and "belongs to someone else", as
      // ProjectsService does: telling them apart is a project-id oracle.
      throw notFound(`Project ${projectId} not found.`);
    }
    return project;
  }

  private async getComponentOrThrow(
    userId: string,
    projectId: string,
    componentId: string,
  ): Promise<Component> {
    await this.getOrThrow(userId, projectId);
    const component = await this.prisma.component.findUnique({ where: { id: componentId } });
    if (!component || component.projectId !== projectId) {
      throw notFound(`Component ${componentId} not found.`);
    }
    return component;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KIND_ORDER: Record<string, number> = { frontend: 0, backend: 1, unknown: 2, database: 3 };

/**
 * Maps an analysis snapshot onto proposed components: one per detected app,
 * plus a Neon database when the analysis suggests one.
 */
export function proposeComponents(repoName: string, analysis: AnalysisResult): ProposedComponent[] {
  const seen = new Set<string>();
  const proposed: ProposedComponent[] = [];

  for (const detected of analysis.components) {
    const kind = detected.role === "frontend" || detected.role === "backend" ? detected.role : null;
    const rootDir = normaliseDir(detected.path);
    // Two detections of one folder (a package.json and a Dockerfile, say) are one component.
    const key = `${kind ?? "unknown"}:${rootDir}`;
    if (seen.has(key)) continue;
    seen.add(key);

    proposed.push({
      kind,
      name: (rootDir === "." ? repoName : rootDir.split("/").pop()!).slice(0, 100),
      rootDir,
      framework: detected.framework,
      installCmd: detected.installCmd,
      buildCmd: detected.buildCmd,
      startCmd: detected.startCmd,
      outputDir: detected.outputDir,
      nodeVersion: detected.runtimeVersion,
      provider: kind ? PROVIDER_FOR_KIND[kind] : null,
      analysisComponentId: detected.id,
      evidence: detected.evidence,
      confidence: detected.confidence,
    });
  }

  if (analysis.database?.suggestNeon) {
    proposed.push({
      kind: "database",
      name: "database",
      rootDir: ".",
      framework: analysis.database.engine === "unknown" ? null : analysis.database.engine,
      installCmd: null,
      buildCmd: null,
      startCmd: null,
      outputDir: null,
      nodeVersion: null,
      provider: PROVIDER_FOR_KIND.database,
      analysisComponentId: null,
      evidence: analysis.database.evidence,
      confidence: null,
    });
  }

  return proposed.sort((a, b) => KIND_ORDER[a.kind ?? "unknown"] - KIND_ORDER[b.kind ?? "unknown"]);
}

function normaliseDir(path: string | null): string {
  const segments = (path ?? "").split("/").filter((s) => s !== "" && s !== ".");
  return segments.length === 0 ? "." : segments.join("/");
}

function repoOf(project: Project): ParsedRepo {
  const fullName = project.repoFullName ?? project.githubFullName;
  const [owner, repo] =
    project.owner && project.repo ? [project.owner, project.repo] : (fullName ?? "").split("/");
  if (!fullName || !owner || !repo) {
    throw badRequest("No GitHub repository connected to this project.");
  }
  return { owner, repo, fullName };
}

/** Keeps messages that are already safe to show; replaces the raw GitHub API body. */
function readableGithubError(error: unknown): Error {
  if (error instanceof GithubError || error instanceof HttpError) {
    return error;
  }
  if (error instanceof GitHubApiError) {
    return new Error(`Could not read the repository from GitHub (HTTP ${error.status}).`);
  }
  return new Error("Could not read the repository from GitHub.");
}
