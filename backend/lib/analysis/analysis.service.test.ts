import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Use vi.hoisted() so mock variables are available inside vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockPrismaProject,
  mockPrismaGitHubConnection,
  mockPrismaProjectComponent,
  mockPrismaTransaction,
  mockGetRepositoryTree,
  mockGetFileContent,
  mockDetectComponents,
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
    mockPrismaProject: { findUnique: vi.fn() },
    mockPrismaGitHubConnection: { findFirst: vi.fn() },
    mockPrismaProjectComponent: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    mockPrismaTransaction: vi.fn(),
    mockGetRepositoryTree: vi.fn(),
    mockGetFileContent: vi.fn(),
    mockDetectComponents: vi.fn(),
    MockGitHubApiError: _MockGitHubApiError,
  };
});

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------
vi.mock("@/lib/db/prisma", () => ({
  default: {
    project: mockPrismaProject,
    gitHubConnection: mockPrismaGitHubConnection,
    projectComponent: mockPrismaProjectComponent,
    $transaction: mockPrismaTransaction,
  },
}));

vi.mock("@/lib/github/github.service", () => ({
  getRepositoryTree: (...args: unknown[]) => mockGetRepositoryTree(...args),
  getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
  GitHubApiError: MockGitHubApiError,
}));

vi.mock("@/lib/analysis/detection.service", () => ({
  detectComponents: (...args: unknown[]) => mockDetectComponents(...args),
}));

import {
  analyzeProject,
  getProjectAnalysis,
  AnalysisError,
} from "@/lib/analysis/analysis.service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const OWNER_ID = "user_owner";
const OTHER_ID = "user_other";
const PROJECT_ID = "project_1";

const fakeProject = {
  id: PROJECT_ID,
  userId: OWNER_ID,
  name: "Test Project",
  githubFullName: "owner/repo",
  githubRepoId: "12345",
  githubUrl: "https://github.com/owner/repo",
  defaultBranch: "main",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeGitHubConnection = {
  id: "conn_1",
  userId: OWNER_ID,
  githubUserId: "gh_123",
  githubUsername: "owner",
  accessToken: "ghp_test_token",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeTree = {
  sha: "abc123",
  tree: [
    { path: "package.json", mode: "100644", type: "blob" as const, sha: "x" },
  ],
  truncated: false,
};

const fakeDetected = [
  {
    type: "web",
    framework: "nextjs",
    language: "typescript",
    path: ".",
    packageManager: "npm",
    detectedVersion: "14.0.0",
    confidence: 0.95,
  },
];

const fakePersistedComponents = [
  {
    id: "comp_1",
    projectId: PROJECT_ID,
    type: "web",
    framework: "nextjs",
    language: "typescript",
    path: ".",
    packageManager: "npm",
    detectedVersion: "14.0.0",
    confidence: 0.95,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  },
];

// ---------------------------------------------------------------------------
// Tests — analyzeProject
// ---------------------------------------------------------------------------
describe("analyzeProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs a successful analysis", async () => {
    mockPrismaProject.findUnique.mockResolvedValue(fakeProject);
    mockPrismaGitHubConnection.findFirst.mockResolvedValue(fakeGitHubConnection);
    mockGetRepositoryTree.mockResolvedValue(fakeTree);
    mockDetectComponents.mockResolvedValue(fakeDetected);
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        projectComponent: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
          findMany: vi.fn().mockResolvedValue(fakePersistedComponents),
        },
      };
      return fn(tx);
    });

    const result = await analyzeProject(PROJECT_ID, OWNER_ID);

    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.projectName).toBe("Test Project");
    expect(result.repository).toBe("owner/repo");
    expect(result.components).toHaveLength(1);
    expect(result.components[0].framework).toBe("nextjs");
    expect(mockGetRepositoryTree).toHaveBeenCalledWith("owner/repo", "main", "ghp_test_token");
  });

  it("throws project_not_found for unknown project", async () => {
    mockPrismaProject.findUnique.mockResolvedValue(null);

    try {
      await analyzeProject("nonexistent", OWNER_ID);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisError);
      expect((err as AnalysisError).code).toBe("project_not_found");
      expect((err as AnalysisError).httpStatus).toBe(404);
    }
  });

  it("throws unauthorized for non-owner", async () => {
    mockPrismaProject.findUnique.mockResolvedValue(fakeProject);

    try {
      await analyzeProject(PROJECT_ID, OTHER_ID);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisError);
      expect((err as AnalysisError).code).toBe("unauthorized");
      expect((err as AnalysisError).httpStatus).toBe(403);
    }
  });

  it("throws github_not_connected when no repo linked", async () => {
    const noRepoProject = { ...fakeProject, githubFullName: null };
    mockPrismaProject.findUnique.mockResolvedValue(noRepoProject);

    try {
      await analyzeProject(PROJECT_ID, OWNER_ID);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisError);
      expect((err as AnalysisError).code).toBe("github_not_connected");
      expect((err as AnalysisError).httpStatus).toBe(400);
    }
  });

  it("throws github_not_connected when no GitHub connection", async () => {
    mockPrismaProject.findUnique.mockResolvedValue(fakeProject);
    mockPrismaGitHubConnection.findFirst.mockResolvedValue(null);

    try {
      await analyzeProject(PROJECT_ID, OWNER_ID);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisError);
      expect((err as AnalysisError).code).toBe("github_not_connected");
    }
  });

  it("throws repo_not_found on GitHub 404", async () => {
    mockPrismaProject.findUnique.mockResolvedValue(fakeProject);
    mockPrismaGitHubConnection.findFirst.mockResolvedValue(fakeGitHubConnection);
    mockGetRepositoryTree.mockRejectedValue(
      new MockGitHubApiError("Not Found", 404, "/repos/owner/repo/git/trees/main"),
    );

    try {
      await analyzeProject(PROJECT_ID, OWNER_ID);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisError);
      expect((err as AnalysisError).code).toBe("repo_not_found");
      expect((err as AnalysisError).httpStatus).toBe(404);
    }
  });

  it("throws github_api_error on GitHub 500", async () => {
    mockPrismaProject.findUnique.mockResolvedValue(fakeProject);
    mockPrismaGitHubConnection.findFirst.mockResolvedValue(fakeGitHubConnection);
    mockGetRepositoryTree.mockRejectedValue(
      new MockGitHubApiError("Internal Server Error", 500, "/repos/owner/repo/git/trees/main"),
    );

    try {
      await analyzeProject(PROJECT_ID, OWNER_ID);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisError);
      expect((err as AnalysisError).code).toBe("github_api_error");
      expect((err as AnalysisError).httpStatus).toBe(502);
    }
  });

  it("replaces old components on repeated analysis", async () => {
    mockPrismaProject.findUnique.mockResolvedValue(fakeProject);
    mockPrismaGitHubConnection.findFirst.mockResolvedValue(fakeGitHubConnection);
    mockGetRepositoryTree.mockResolvedValue(fakeTree);
    mockDetectComponents.mockResolvedValue(fakeDetected);

    const mockDeleteMany = vi.fn();
    const mockCreateMany = vi.fn();
    const mockFindMany = vi.fn().mockResolvedValue(fakePersistedComponents);

    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        projectComponent: {
          deleteMany: mockDeleteMany,
          createMany: mockCreateMany,
          findMany: mockFindMany,
        },
      };
      return fn(tx);
    });

    await analyzeProject(PROJECT_ID, OWNER_ID);

    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { projectId: PROJECT_ID } });
    expect(mockCreateMany).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — getProjectAnalysis
// ---------------------------------------------------------------------------
describe("getProjectAnalysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns stored components", async () => {
    mockPrismaProject.findUnique.mockResolvedValue(fakeProject);
    mockPrismaProjectComponent.findMany.mockResolvedValue(fakePersistedComponents);

    const result = await getProjectAnalysis(PROJECT_ID, OWNER_ID);

    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.components).toHaveLength(1);
    expect(result.components[0].id).toBe("comp_1");
    // Ensure no accessToken leaks in JSON
    expect(JSON.stringify(result)).not.toContain("ghp_test_token");
  });

  it("throws for non-owner", async () => {
    mockPrismaProject.findUnique.mockResolvedValue(fakeProject);

    await expect(getProjectAnalysis(PROJECT_ID, OTHER_ID))
      .rejects.toThrow(AnalysisError);
  });

  it("throws for non-existent project", async () => {
    mockPrismaProject.findUnique.mockResolvedValue(null);

    await expect(getProjectAnalysis("nonexistent", OWNER_ID))
      .rejects.toThrow(AnalysisError);
  });
});
