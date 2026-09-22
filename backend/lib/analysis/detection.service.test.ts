import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitHubTreeEntry } from "@/lib/github/github.service";
import {
  detectComponents,
  getRequiredConfigFiles,
} from "@/lib/analysis/detection.service";

describe("getRequiredConfigFiles", () => {
  it("extracts config files from a tree", () => {
    const tree: GitHubTreeEntry[] = [
      { path: "package.json", mode: "100644", type: "blob", sha: "a" },
      { path: "src/index.ts", mode: "100644", type: "blob", sha: "b" },
      { path: "apps/api/go.mod", mode: "100644", type: "blob", sha: "c" },
      { path: "Dockerfile", mode: "100644", type: "blob", sha: "d" },
      { path: "src", mode: "040000", type: "tree", sha: "e" },
    ];

    const result = getRequiredConfigFiles(tree);

    expect(result).toContain("package.json");
    expect(result).toContain("apps/api/go.mod");
    expect(result).toContain("Dockerfile");
    expect(result).not.toContain("src/index.ts");
    expect(result).not.toContain("src");
  });

  it("returns empty array for tree with no config files", () => {
    const tree: GitHubTreeEntry[] = [
      { path: "src/index.ts", mode: "100644", type: "blob", sha: "a" },
      { path: "README.md", mode: "100644", type: "blob", sha: "b" },
    ];

    expect(getRequiredConfigFiles(tree)).toEqual([]);
  });
});

describe("detectComponents", () => {
  let fetchContent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchContent = vi.fn();
  });

  it("detects a Next.js project", async () => {
    const tree: GitHubTreeEntry[] = [
      { path: "package.json", mode: "100644", type: "blob", sha: "a" },
    ];

    fetchContent.mockResolvedValue(
      JSON.stringify({
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
    );

    const result = await detectComponents(tree, fetchContent);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "web",
      framework: "nextjs",
      language: "typescript",
      packageManager: "npm",
      confidence: 0.95,
    });
    expect(result[0].detectedVersion).toBe("14.0.0");
  });

  it("detects a React project (without Next.js)", async () => {
    const tree: GitHubTreeEntry[] = [
      { path: "package.json", mode: "100644", type: "blob", sha: "a" },
    ];

    fetchContent.mockResolvedValue(
      JSON.stringify({
        dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
      }),
    );

    const result = await detectComponents(tree, fetchContent);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "web",
      framework: "react",
      language: "javascript",
    });
  });

  it("detects an Express API", async () => {
    const tree: GitHubTreeEntry[] = [
      { path: "server/package.json", mode: "100644", type: "blob", sha: "a" },
    ];

    fetchContent.mockResolvedValue(
      JSON.stringify({
        dependencies: { express: "^4.18.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
    );

    const result = await detectComponents(tree, fetchContent);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "api",
      framework: "express",
      language: "typescript",
      path: "server",
    });
  });

  it("detects a Django project from requirements.txt", async () => {
    const tree: GitHubTreeEntry[] = [
      { path: "requirements.txt", mode: "100644", type: "blob", sha: "a" },
    ];

    fetchContent.mockResolvedValue("Django>=4.2\ncelery>=5.0\n");

    const result = await detectComponents(tree, fetchContent);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "web",
      framework: "django",
      language: "python",
      packageManager: "pip",
    });
    expect(result[0].detectedVersion).toBe("4.2");
  });

  it("detects a Go project from go.mod", async () => {
    const tree: GitHubTreeEntry[] = [
      { path: "go.mod", mode: "100644", type: "blob", sha: "a" },
    ];

    fetchContent.mockResolvedValue(
      'module example.com/myapp\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
    );

    const result = await detectComponents(tree, fetchContent);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "api",
      framework: "gin",
      language: "go",
      detectedVersion: "1.21",
    });
  });

  it("detects multiple components in a monorepo", async () => {
    const tree: GitHubTreeEntry[] = [
      { path: "apps/web/package.json", mode: "100644", type: "blob", sha: "a" },
      { path: "apps/api/package.json", mode: "100644", type: "blob", sha: "b" },
    ];

    fetchContent.mockImplementation(async (path: string) => {
      if (path === "apps/web/package.json") {
        return JSON.stringify({
          dependencies: { next: "^14.0.0", react: "^18.0.0" },
          devDependencies: { typescript: "^5.0.0" },
        });
      }
      return JSON.stringify({
        dependencies: { express: "^4.18.0" },
      });
    });

    const result = await detectComponents(tree, fetchContent);

    expect(result).toHaveLength(2);
    expect(result.find((c) => c.framework === "nextjs")).toBeDefined();
    expect(result.find((c) => c.framework === "express")).toBeDefined();
  });

  it("skips Dockerfile when a stronger signal exists in same dir", async () => {
    const tree: GitHubTreeEntry[] = [
      { path: "package.json", mode: "100644", type: "blob", sha: "a" },
      { path: "Dockerfile", mode: "100644", type: "blob", sha: "b" },
    ];

    fetchContent.mockResolvedValue(
      JSON.stringify({
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
      }),
    );

    const result = await detectComponents(tree, fetchContent);

    expect(result).toHaveLength(1);
    expect(result[0].framework).toBe("nextjs");
  });

  it("returns empty array for empty tree", async () => {
    const result = await detectComponents([], fetchContent);
    expect(result).toEqual([]);
    expect(fetchContent).not.toHaveBeenCalled();
  });

  it("handles malformed package.json gracefully", async () => {
    const tree: GitHubTreeEntry[] = [
      { path: "package.json", mode: "100644", type: "blob", sha: "a" },
    ];

    fetchContent.mockResolvedValue("this is not valid json {{{");

    const result = await detectComponents(tree, fetchContent);
    expect(result).toEqual([]);
  });
});
