import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Use vi.hoisted() so mock variables are available inside vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockGetRepositoryTree,
  mockGetFileContent,
  mockDetectComponents,
  mockDownloadSource,
  mockWalkSourceTree,
  mockReadSourceFile,
  mockRemoveDir,
  MockGitHubApiError,
} = vi.hoisted(() => {
  class _MockGitHubApiError extends Error {
    status: number;
    endpoint: string;
    constructor(message: string, status: number, endpoint: string) {
      super(message);
      this.name = "GitHubApiError";
      this.status = status;
      this.endpoint = endpoint;
    }
  }

  return {
    mockGetRepositoryTree: vi.fn(),
    mockGetFileContent: vi.fn(),
    mockDetectComponents: vi.fn(),
    mockDownloadSource: vi.fn(),
    mockWalkSourceTree: vi.fn(),
    mockReadSourceFile: vi.fn(),
    mockRemoveDir: vi.fn(),
    MockGitHubApiError: _MockGitHubApiError,
  };
});

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------
vi.mock("@/lib/github/github.service", () => ({
  getRepositoryTree: (...args: unknown[]) => mockGetRepositoryTree(...args),
  getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
  GitHubApiError: MockGitHubApiError,
}));

vi.mock("@/lib/analysis/detection.service", () => ({
  detectComponents: (...args: unknown[]) => mockDetectComponents(...args),
}));

vi.mock("@/lib/github/source-archive", () => ({
  downloadSource: (...args: unknown[]) => mockDownloadSource(...args),
  walkSourceTree: (...args: unknown[]) => mockWalkSourceTree(...args),
  readSourceFile: (...args: unknown[]) => mockReadSourceFile(...args),
}));

vi.mock("@/lib/common/fs-utils", () => ({
  removeDir: (...args: unknown[]) => mockRemoveDir(...args),
}));

import { AnalysisService } from "@/lib/analysis/analysis.service";
import { HttpError } from "@/lib/api/http-error";
import { GithubError, type GithubAppService } from "@/lib/github/github-app.service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const OWNER_ID = "user_owner";
const OTHER_ID = "user_other";
const PROJECT_ID = "project_1";
const ANALYSIS_ID = "analysis_new";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "ghs_installationtoken0123456789abcdef";

const fakeProject = {
  id: PROJECT_ID,
  userId: OWNER_ID,
  name: "Test Project",
  githubFullName: "owner/repo",
  repoFullName: "owner/repo",
  owner: "owner",
  repo: "repo",
  defaultBranch: "main",
  branch: "develop",
  installationId: "inst_1",
};

const fakeTree = {
  sha: SHA,
  tree: [{ path: "package.json", mode: "100644", type: "blob" as const, sha: "x" }],
  truncated: false,
};

const fakeDetected = {
  components: [
    {
      type: "web",
      role: "frontend",
      framework: "nextjs",
      language: "typescript",
      path: ".",
      packageManager: "npm",
      detectedVersion: "14.0.0",
      confidence: 0.95,
      installCmd: "npm install",
      buildCmd: "npm run build",
      startCmd: "npm start",
      outputDir: ".next",
      runtimeVersion: "20",
      evidence: ["package.json: next@^14.0.0"],
    },
  ],
  warnings: [{ code: "ignored_paths", message: "2 config file(s) were skipped." }],
  database: { detected: false, engine: "unknown", evidence: [], suggestNeon: false },
};

const componentRow = {
  id: "comp_1",
  projectId: PROJECT_ID,
  analysisId: ANALYSIS_ID,
  ...fakeDetected.components[0],
  createdAt: new Date("2026-09-30T10:00:00Z"),
  updatedAt: new Date("2026-09-30T10:00:00Z"),
};

const analysisRow = (overrides: Record<string, unknown> = {}) => ({
  id: ANALYSIS_ID,
  projectId: PROJECT_ID,
  branch: "develop",
  commitSha: SHA,
  status: "succeeded",
  source: "tree",
  warnings: fakeDetected.warnings,
  database: fakeDetected.database,
  error: null,
  createdAt: new Date("2026-09-30T10:00:00Z"),
  finishedAt: new Date("2026-09-30T10:00:05Z"),
  components: [componentRow],
  ...overrides,
});

/**
 * A Prisma double with only the delegates the service is allowed to touch.
 * There is deliberately no `gitHubConnection`: reaching for a stored user
 * token again would throw here rather than pass quietly.
 */
function makePrisma() {
  const prisma = {
    project: { findUnique: vi.fn().mockResolvedValue(fakeProject) },
    analysis: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([{ id: ANALYSIS_ID }]),
      create: vi.fn().mockResolvedValue({ id: ANALYSIS_ID }),
      update: vi.fn().mockResolvedValue(analysisRow()),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    projectComponent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return prisma;
}

function makeGithub() {
  return {
    resolveInstallationId: vi.fn().mockResolvedValue("inst_resolved"),
    getBranchHeadSha: vi.fn().mockResolvedValue(SHA),
    getInstallationToken: vi.fn().mockResolvedValue(TOKEN),
  };
}

function setup() {
  const prisma = makePrisma();
  const github = makeGithub();
  const service = new AnalysisService(
    prisma as unknown as PrismaClient,
    github as unknown as GithubAppService,
  );
  return { prisma, github, service };
}

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("Should have thrown");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRepositoryTree.mockResolvedValue(fakeTree);
  mockDetectComponents.mockResolvedValue(fakeDetected);
  mockRemoveDir.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// Tests — analyze
// ---------------------------------------------------------------------------
describe("AnalysisService.analyze", () => {
  it("runs a successful analysis", async () => {
    const { service } = setup();

    const result = await service.analyze(OWNER_ID, PROJECT_ID);

    expect(result).toMatchObject({
      projectId: PROJECT_ID,
      projectName: "Test Project",
      repository: "owner/repo",
      analysisId: ANALYSIS_ID,
      branch: "develop",
      commitSha: SHA,
      source: "tree",
      reused: false,
      warnings: fakeDetected.warnings,
      database: fakeDetected.database,
    });
    expect(result.analyzedAt).toBe("2026-09-30T10:00:05.000Z");
    expect(result.components).toHaveLength(1);
    expect(result.components[0]).toMatchObject({
      id: "comp_1",
      role: "frontend",
      framework: "nextjs",
      buildCmd: "npm run build",
      outputDir: ".next",
      evidence: ["package.json: next@^14.0.0"],
    });
  });

  it("authenticates with the installation token, not a stored user token", async () => {
    const { service, github } = setup();

    await service.analyze(OWNER_ID, PROJECT_ID);

    expect(github.resolveInstallationId).not.toHaveBeenCalled();
    expect(github.getInstallationToken).toHaveBeenCalledWith("inst_1");
    expect(mockGetRepositoryTree).toHaveBeenCalledWith("owner/repo", SHA, TOKEN);
  });

  it("resolves the installation for a project created before it was stored", async () => {
    const { service, prisma, github } = setup();
    prisma.project.findUnique.mockResolvedValue({ ...fakeProject, installationId: null });

    await service.analyze(OWNER_ID, PROJECT_ID);

    expect(github.resolveInstallationId).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
    });
    expect(github.getInstallationToken).toHaveBeenCalledWith("inst_resolved");
  });

  it("analyses the project's branch, falling back to the default branch", async () => {
    const { service, prisma, github } = setup();

    await service.analyze(OWNER_ID, PROJECT_ID);
    expect(github.getBranchHeadSha).toHaveBeenLastCalledWith(expect.anything(), "develop", "inst_1");

    prisma.project.findUnique.mockResolvedValue({ ...fakeProject, branch: null });
    await service.analyze(OWNER_ID, PROJECT_ID);
    expect(github.getBranchHeadSha).toHaveBeenLastCalledWith(expect.anything(), "main", "inst_1");
  });

  it("pins the tree and every file read to the commit SHA", async () => {
    const { service, prisma } = setup();
    mockGetFileContent.mockResolvedValue("{}");

    await service.analyze(OWNER_ID, PROJECT_ID);

    expect(prisma.analysis.create).toHaveBeenCalledWith({
      data: { projectId: PROJECT_ID, branch: "develop", commitSha: SHA, source: "tree" },
    });
    expect(mockGetRepositoryTree).toHaveBeenCalledWith("owner/repo", SHA, TOKEN);

    const [tree, fetchContent] = mockDetectComponents.mock.calls[0];
    expect(tree).toBe(fakeTree.tree);
    await fetchContent("apps/web/package.json");
    expect(mockGetFileContent).toHaveBeenCalledWith("owner/repo", "apps/web/package.json", SHA, TOKEN);
  });

  it("stores the components against the new snapshot", async () => {
    const { service, prisma } = setup();

    await service.analyze(OWNER_ID, PROJECT_ID);

    expect(prisma.projectComponent.createMany).toHaveBeenCalledWith({
      data: [
        {
          projectId: PROJECT_ID,
          analysisId: ANALYSIS_ID,
          ...fakeDetected.components[0],
        },
      ],
    });
    expect(prisma.analysis.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ANALYSIS_ID },
        data: expect.objectContaining({
          status: "succeeded",
          source: "tree",
          warnings: fakeDetected.warnings,
          database: fakeDetected.database,
        }),
      }),
    );
  });

  it("returns the existing snapshot when the commit was already analysed", async () => {
    const { service, prisma, github } = setup();
    prisma.analysis.findFirst.mockResolvedValue(analysisRow({ id: "analysis_old" }));

    const result = await service.analyze(OWNER_ID, PROJECT_ID);

    expect(result).toMatchObject({ analysisId: "analysis_old", reused: true, commitSha: SHA });
    expect(prisma.analysis.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: PROJECT_ID, branch: "develop", commitSha: SHA, status: "succeeded" },
      }),
    );
    expect(prisma.analysis.create).not.toHaveBeenCalled();
    expect(github.getInstallationToken).not.toHaveBeenCalled();
    expect(mockGetRepositoryTree).not.toHaveBeenCalled();
  });

  it("re-runs an already analysed commit when forced", async () => {
    const { service, prisma } = setup();
    prisma.analysis.findFirst.mockResolvedValue(analysisRow({ id: "analysis_old" }));

    const result = await service.analyze(OWNER_ID, PROJECT_ID, { force: true });

    expect(result).toMatchObject({ analysisId: ANALYSIS_ID, reused: false });
    expect(prisma.analysis.findFirst).not.toHaveBeenCalled();
    expect(prisma.analysis.create).toHaveBeenCalled();
  });

  it("keeps the last five snapshots and deletes the rest", async () => {
    const { service, prisma } = setup();
    const kept = ["a5", "a4", "a3", "a2", "a1"].map((id) => ({ id }));
    prisma.analysis.findMany.mockResolvedValue(kept);

    await service.analyze(OWNER_ID, PROJECT_ID);

    expect(prisma.analysis.findMany).toHaveBeenCalledWith({
      where: { projectId: PROJECT_ID, status: "succeeded" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true },
    });
    expect(prisma.analysis.deleteMany).toHaveBeenCalledWith({
      where: {
        projectId: PROJECT_ID,
        status: { not: "running" },
        id: { notIn: ["a5", "a4", "a3", "a2", "a1"] },
      },
    });
  });

  it("falls back to a source download when the tree is truncated", async () => {
    const { service, prisma, github } = setup();
    const walked = [{ path: "web/package.json", mode: "100644", type: "blob", sha: "" }];
    mockGetRepositoryTree.mockResolvedValue({ ...fakeTree, truncated: true });
    mockWalkSourceTree.mockResolvedValue(walked);
    mockReadSourceFile.mockResolvedValue("{}");
    prisma.analysis.update.mockResolvedValue(analysisRow({ source: "tarball" }));

    const result = await service.analyze(OWNER_ID, PROJECT_ID);

    const workDir = mockDownloadSource.mock.calls[0][4] as string;
    expect(mockDownloadSource).toHaveBeenCalledWith(
      github,
      { owner: "owner", repo: "repo", fullName: "owner/repo" },
      SHA,
      "inst_1",
      workDir,
    );
    expect(workDir).toMatch(/analysis[\\/]analysis_new$/);

    // Detection ran over the files on disk, not the partial tree.
    const [tree, fetchContent] = mockDetectComponents.mock.calls[0];
    expect(tree).toBe(walked);
    await fetchContent("web/package.json");
    expect(mockReadSourceFile).toHaveBeenCalledWith(workDir, "web/package.json");
    expect(mockGetFileContent).not.toHaveBeenCalled();

    const saved = prisma.analysis.update.mock.calls[0][0].data;
    expect(saved.source).toBe("tarball");
    expect(saved.warnings[0]).toMatchObject({ code: "tree_truncated" });
    expect(result.source).toBe("tarball");
    expect(mockRemoveDir).toHaveBeenCalledWith(workDir);
  });

  it("removes the downloaded source even when detection fails", async () => {
    const { service } = setup();
    mockGetRepositoryTree.mockResolvedValue({ ...fakeTree, truncated: true });
    mockWalkSourceTree.mockResolvedValue([]);
    mockDetectComponents.mockRejectedValue(new Error("boom"));

    const error = await failure(service.analyze(OWNER_ID, PROJECT_ID));

    expect(error.code).toBe("analysis_failed");
    expect(mockRemoveDir).toHaveBeenCalledTimes(1);
  });

  it("throws project_not_found for an unknown project", async () => {
    const { service, prisma } = setup();
    prisma.project.findUnique.mockResolvedValue(null);

    const error = await failure(service.analyze(OWNER_ID, "nonexistent"));

    expect(error.code).toBe("project_not_found");
    expect(error.status).toBe(404);
  });

  it("gives a non-owner the same answer as a missing project", async () => {
    const { service, github } = setup();

    const error = await failure(service.analyze(OTHER_ID, PROJECT_ID));

    expect(error.code).toBe("project_not_found");
    expect(error.status).toBe(404);
    expect(github.getBranchHeadSha).not.toHaveBeenCalled();
  });

  it("throws github_not_connected when no repo is linked", async () => {
    const { service, prisma } = setup();
    prisma.project.findUnique.mockResolvedValue({
      ...fakeProject,
      githubFullName: null,
      repoFullName: null,
      owner: null,
      repo: null,
    });

    const error = await failure(service.analyze(OWNER_ID, PROJECT_ID));

    expect(error.code).toBe("github_not_connected");
    expect(error.status).toBe(400);
  });

  it("reports a missing branch or installation without creating a snapshot", async () => {
    const { service, prisma, github } = setup();
    github.getBranchHeadSha.mockRejectedValue(
      new GithubError('Branch "develop" does not exist on owner/repo.', 404),
    );

    const error = await failure(service.analyze(OWNER_ID, PROJECT_ID));

    expect(error.code).toBe("repo_not_found");
    expect(error.status).toBe(404);
    expect(error.message).toContain('Branch "develop"');
    expect(prisma.analysis.create).not.toHaveBeenCalled();
  });

  it("throws repo_not_found on GitHub 404 and records the failed run", async () => {
    const { service, prisma } = setup();
    mockGetRepositoryTree.mockRejectedValue(
      new MockGitHubApiError("Not Found", 404, "/repos/owner/repo/git/trees/sha"),
    );

    const error = await failure(service.analyze(OWNER_ID, PROJECT_ID));

    expect(error.code).toBe("repo_not_found");
    expect(error.status).toBe(404);
    expect(prisma.analysis.update).toHaveBeenCalledWith({
      where: { id: ANALYSIS_ID },
      data: expect.objectContaining({ status: "failed", error: error.message }),
    });
    expect(prisma.analysis.deleteMany).toHaveBeenCalledWith({
      where: { projectId: PROJECT_ID, status: "failed", id: { not: ANALYSIS_ID } },
    });
    expect(prisma.projectComponent.createMany).not.toHaveBeenCalled();
  });

  it("throws github_api_error on GitHub 500", async () => {
    const { service } = setup();
    mockGetRepositoryTree.mockRejectedValue(
      new MockGitHubApiError("Internal Server Error", 500, "/repos/owner/repo/git/trees/sha"),
    );

    const error = await failure(service.analyze(OWNER_ID, PROJECT_ID));

    expect(error.code).toBe("github_api_error");
    expect(error.status).toBe(502);
  });

  it("never lets the installation token reach a response or a stored error", async () => {
    const { service, prisma } = setup();
    mockGetRepositoryTree.mockRejectedValue(
      new MockGitHubApiError(`upstream echoed Bearer ${TOKEN}`, 500, "/x"),
    );

    const error = await failure(service.analyze(OWNER_ID, PROJECT_ID));
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(prisma.analysis.update.mock.calls)).not.toContain(TOKEN);

    mockGetRepositoryTree.mockResolvedValue(fakeTree);
    const result = await service.analyze(OWNER_ID, PROJECT_ID);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Tests — getLatest
// ---------------------------------------------------------------------------
describe("AnalysisService.getLatest", () => {
  it("returns the latest successful snapshot", async () => {
    const { service, prisma } = setup();
    prisma.analysis.findFirst.mockResolvedValue(analysisRow());

    const result = await service.getLatest(OWNER_ID, PROJECT_ID);

    expect(prisma.analysis.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: PROJECT_ID, status: "succeeded" },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(result).toMatchObject({ analysisId: ANALYSIS_ID, commitSha: SHA, reused: false });
    expect(result.components[0].id).toBe("comp_1");
  });

  it("returns an empty result for a project that was never analysed", async () => {
    const { service } = setup();

    const result = await service.getLatest(OWNER_ID, PROJECT_ID);

    expect(result).toMatchObject({
      projectId: PROJECT_ID,
      analysisId: null,
      commitSha: null,
      analyzedAt: "",
      warnings: [],
      database: null,
      components: [],
    });
  });

  it("throws for non-owner", async () => {
    const { service } = setup();

    const error = await failure(service.getLatest(OTHER_ID, PROJECT_ID));
    expect(error.status).toBe(404);
  });

  it("throws for non-existent project", async () => {
    const { service, prisma } = setup();
    prisma.project.findUnique.mockResolvedValue(null);

    const error = await failure(service.getLatest(OWNER_ID, "nonexistent"));
    expect(error.code).toBe("project_not_found");
  });
});
