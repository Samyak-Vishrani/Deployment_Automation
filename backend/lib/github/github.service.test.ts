import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getRepositoryTree,
  getFileContent,
  GitHubApiError,
} from "@/lib/github/github.service";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getRepositoryTree
// ---------------------------------------------------------------------------
describe("getRepositoryTree", () => {
  it("returns the tree on success", async () => {
    const fakeTree = {
      sha: "abc123",
      tree: [{ path: "package.json", mode: "100644", type: "blob", sha: "x" }],
      truncated: false,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => fakeTree,
    });

    const result = await getRepositoryTree("owner/repo", "main", "ghp_token");

    expect(result).toEqual(fakeTree);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_token",
        }),
      }),
    );
  });

  it("throws GitHubApiError on 404", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '{"message":"Not Found"}',
    });

    await expect(
      getRepositoryTree("owner/repo", "main", "ghp_token"),
    ).rejects.toThrow(GitHubApiError);

    try {
      await getRepositoryTree("owner/repo", "main", "ghp_token");
    } catch (err) {
      expect((err as GitHubApiError).status).toBe(404);
    }
  });

  it("throws GitHubApiError on 500", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(
      getRepositoryTree("owner/repo", "main", "ghp_token"),
    ).rejects.toThrow(GitHubApiError);
  });
});

// ---------------------------------------------------------------------------
// getFileContent
// ---------------------------------------------------------------------------
describe("getFileContent", () => {
  it("returns file content on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => '{"name":"my-app","dependencies":{}}',
    });

    const result = await getFileContent("owner/repo", "package.json", "main", "ghp_token");

    expect(result).toBe('{"name":"my-app","dependencies":{}}');
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/contents/package.json?ref=main",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github.v3.raw",
        }),
      }),
    );
  });

  it("throws GitHubApiError on failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"message":"rate limit exceeded"}',
    });

    await expect(
      getFileContent("owner/repo", "package.json", "main", "ghp_token"),
    ).rejects.toThrow(GitHubApiError);
  });
});
