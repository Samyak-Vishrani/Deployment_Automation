import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readSourceFile, walkSourceTree } from "@/lib/github/source-archive";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orbitops-source-"));
  await mkdir(join(root, "apps", "web"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"root"}');
  await writeFile(join(root, "apps", "web", "package.json"), '{"name":"web"}');
  await writeFile(join(root, ".git", "config"), "");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("walkSourceTree", () => {
  it("lists files and folders with forward-slash paths, like the tree API", async () => {
    const entries = await walkSourceTree(root);

    expect(entries.map((entry) => `${entry.type} ${entry.path}`).sort()).toEqual([
      "blob apps/web/package.json",
      "blob package.json",
      "tree apps",
      "tree apps/web",
    ]);
  });

  it("does not follow symlinks", async () => {
    try {
      await symlink(join(root, "package.json"), join(root, "apps", "linked.json"));
    } catch {
      return; // Creating symlinks needs elevation on Windows; nothing to assert.
    }

    const entries = await walkSourceTree(root);

    expect(entries.map((entry) => entry.path)).not.toContain("apps/linked.json");
  });
});

describe("readSourceFile", () => {
  it("reads a file by its repository path", async () => {
    await expect(readSourceFile(root, "apps/web/package.json")).resolves.toBe('{"name":"web"}');
  });

  it("refuses a path that leaves the source directory", async () => {
    await expect(readSourceFile(root, "../outside.txt")).rejects.toThrow(/escapes/);
    await expect(readSourceFile(root, "apps/../../outside.txt")).rejects.toThrow(/escapes/);
  });

  it("refuses a file too large to be configuration", async () => {
    await writeFile(join(root, "huge.json"), Buffer.alloc(1024 * 1024 + 1));

    await expect(readSourceFile(root, "huge.json")).rejects.toThrow(/too large/);
  });
});
