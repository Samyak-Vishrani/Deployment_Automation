/**
 * Analysis orchestration service.
 *
 * Coordinates between:
 * - Prisma (project ownership, persisting components)
 * - GitHub service (fetching tree + file contents)
 * - Detection engine (analyzing the tree)
 */

import prisma from "@/lib/db/prisma";
import {
  getRepositoryTree,
  getFileContent,
  GitHubApiError,
} from "@/lib/github/github.service";
import {
  detectComponents,
  type DetectedComponent,
} from "@/lib/analysis/detection.service";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class AnalysisError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AnalysisResult = {
  projectId: string;
  projectName: string;
  repository: string;
  analyzedAt: string;
  components: PersistedComponent[];
};

export type PersistedComponent = {
  id: string;
  type: string;
  framework: string | null;
  language: string | null;
  path: string | null;
  packageManager: string | null;
  detectedVersion: string | null;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Main service functions
// ---------------------------------------------------------------------------

/**
 * Runs a full analysis for a project:
 * 1. Verifies project ownership.
 * 2. Gets the GitHub connection + access token.
 * 3. Fetches the repo file tree.
 * 4. Runs the detection engine.
 * 5. Replaces old components with the new analysis.
 */
export async function analyzeProject(
  projectId: string,
  userId: string,
): Promise<AnalysisResult> {
  // 1. Get project and verify ownership
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });

  if (!project) {
    throw new AnalysisError("Project not found.", "project_not_found", 404);
  }

  if (project.userId !== userId) {
    throw new AnalysisError(
      "You do not have access to this project.",
      "unauthorized",
      403,
    );
  }

  // 2. Ensure the project has a connected GitHub repo
  if (!project.githubFullName) {
    throw new AnalysisError(
      "No GitHub repository connected to this project.",
      "github_not_connected",
      400,
    );
  }

  // 3. Get the user's GitHub access token
  const githubConnection = await prisma.gitHubConnection.findFirst({
    where: { userId },
  });

  if (!githubConnection?.accessToken) {
    throw new AnalysisError(
      "No GitHub connection found. Please connect your GitHub account.",
      "github_not_connected",
      400,
    );
  }

  const branch = project.defaultBranch ?? "main";

  // 4. Fetch the repository tree
  let tree;
  try {
    tree = await getRepositoryTree(
      project.githubFullName,
      branch,
      githubConnection.accessToken,
    );
  } catch (error) {
    if (error instanceof GitHubApiError) {
      if (error.status === 404) {
        throw new AnalysisError(
          `Repository "${project.githubFullName}" not found or inaccessible.`,
          "repo_not_found",
          404,
        );
      }
      throw new AnalysisError(
        `GitHub API error: ${error.message}`,
        "github_api_error",
        502,
      );
    }
    throw new AnalysisError(
      "Failed to access the GitHub repository.",
      "github_api_error",
      502,
    );
  }

  // 5. Run the detection engine
  const fetchContent = async (path: string): Promise<string> => {
    return getFileContent(
      project.githubFullName!,
      path,
      branch,
      githubConnection.accessToken!,
    );
  };

  let detected: DetectedComponent[];
  try {
    detected = await detectComponents(tree.tree, fetchContent);
  } catch (error) {
    if (error instanceof GitHubApiError) {
      throw new AnalysisError(
        `Failed to fetch configuration files: ${error.message}`,
        "github_api_error",
        502,
      );
    }
    throw new AnalysisError(
      "Analysis engine failed.",
      "analysis_failed",
      500,
    );
  }

  // 6. Persist: delete old components, insert new ones (in a transaction)
  const components = await prisma.$transaction(async (tx) => {
    await tx.projectComponent.deleteMany({
      where: { projectId },
    });

    if (detected.length === 0) {
      return [];
    }

    await tx.projectComponent.createMany({
      data: detected.map((comp) => ({
        projectId,
        type: comp.type,
        framework: comp.framework,
        language: comp.language,
        path: comp.path,
        packageManager: comp.packageManager,
        detectedVersion: comp.detectedVersion,
        confidence: comp.confidence,
      })),
    });

    return tx.projectComponent.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
  });

  return {
    projectId: project.id,
    projectName: project.name,
    repository: project.githubFullName,
    analyzedAt: new Date().toISOString(),
    components: components.map(toPersistedComponent),
  };
}

/**
 * Returns the latest analysis for a project (its persisted components).
 */
export async function getProjectAnalysis(
  projectId: string,
  userId: string,
): Promise<AnalysisResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });

  if (!project) {
    throw new AnalysisError("Project not found.", "project_not_found", 404);
  }

  if (project.userId !== userId) {
    throw new AnalysisError(
      "You do not have access to this project.",
      "unauthorized",
      403,
    );
  }

  const components = await prisma.projectComponent.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
  });

  return {
    projectId: project.id,
    projectName: project.name,
    repository: project.githubFullName ?? "",
    analyzedAt: components.length > 0
      ? components[components.length - 1].updatedAt.toISOString()
      : "",
    components: components.map(toPersistedComponent),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPersistedComponent(row: {
  id: string;
  type: string;
  framework: string | null;
  language: string | null;
  path: string | null;
  packageManager: string | null;
  detectedVersion: string | null;
  confidence: number | null;
  createdAt: Date;
  updatedAt: Date;
}): PersistedComponent {
  return {
    id: row.id,
    type: row.type,
    framework: row.framework,
    language: row.language,
    path: row.path,
    packageManager: row.packageManager,
    detectedVersion: row.detectedVersion,
    confidence: row.confidence,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
