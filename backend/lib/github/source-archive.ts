import { createGunzip } from "node:zlib";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import type { GithubAppService } from "./github-app.service";
import type { GitHubTreeEntry } from "./github.service";
import type { ParsedRepo } from "./repo-url";

/** Files larger than this are never configuration the analysis needs. */
const MAX_SOURCE_FILE_BYTES = 1024 * 1024;

/**
 * Downloads a repository at an exact ref and extracts it into `destDir`.
 *
 * Shared by the deploy executor (which builds from it) and the analysis (which
 * falls back to it when the tree API truncates). The caller owns `destDir` and
 * is responsible for removing it.
 */
export async function downloadSource(
  github: GithubAppService,
  repo: ParsedRepo,
  ref: string,
  installationId: string,
  destDir: string,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const tarball = await github.openSourceTarball(repo, ref, installationId);
  // strip: 1 removes GitHub's "<owner>-<repo>-<sha>/" wrapper directory.
  await pipeline(tarball, createGunzip(), tar.extract({ cwd: destDir, strip: 1 }));
}

/**
 * Walks an extracted source directory into the same shape the git tree API
 * returns, so detection does not need to know which of the two it was given.
 *
 * Symlinks are skipped, not followed: the archive is untrusted input, and a
 * link named package.json pointing outside the workspace would otherwise have
 * us read an arbitrary host file.
 */
export async function walkSourceTree(rootDir: string): Promise<GitHubTreeEntry[]> {
  const entries: GitHubTreeEntry[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) {
        if (child.name === ".git") continue;
        entries.push({ path, mode: "040000", type: "tree", sha: "" });
        await walk(join(dir, child.name), path);
      } else if (child.isFile()) {
        entries.push({ path, mode: "100644", type: "blob", sha: "" });
      }
    }
  };

  await walk(rootDir, "");
  return entries;
}

/** Reads one file of an extracted source directory, refusing to leave it. */
export async function readSourceFile(rootDir: string, path: string): Promise<string> {
  const base = resolve(rootDir);
  const target = resolve(base, path);
  if (!target.startsWith(base + sep)) {
    throw new Error(`Path "${path}" escapes the source directory.`);
  }

  const info = await stat(target);
  if (info.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`File is too large to analyse (${info.size} bytes).`);
  }
  return readFile(target, "utf8");
}
