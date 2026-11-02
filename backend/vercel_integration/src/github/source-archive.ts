import { createGunzip } from "node:zlib";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

/**
 * Downloads a GitHub repository at an exact commit and extracts it.
 *
 * Adapted from backend/lib/github (openSourceTarball + downloadSource): the
 * main backend owns the GitHub App, so it mints the installation token and
 * passes it in, and this service only uses it for this one download. The token
 * travels in a header, never on a command line.
 */

const GITHUB_API = "https://api.github.com";

export async function downloadRepoAt(
  repoFullName: string,
  sha: string,
  githubToken: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`"${repoFullName}" is not an owner/repo name.`);
  }
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(sha)}`;

  // redirect: "manual" because GitHub answers 302 to a pre-signed codeload URL,
  // and the Authorization header must not be forwarded to another host.
  const first = await fetch(url, {
    redirect: "manual",
    signal,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "orbitops-vercel-integration",
      authorization: `Bearer ${githubToken}`,
    },
  });

  let response = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    await first.arrayBuffer().catch(() => undefined);
    if (!location) {
      throw new Error("GitHub redirected the source download without a location.");
    }
    response = await fetch(location, { signal, headers: { "user-agent": "orbitops-vercel-integration" } });
  }

  if (!response.ok || !response.body) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(
      response.status === 404
        ? `GitHub could not find ${repoFullName} at ${sha.slice(0, 7)} (or the installation lost access).`
        : `Downloading the source from GitHub failed (HTTP ${response.status}).`,
    );
  }

  await mkdir(destDir, { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    createGunzip(),
    // strip: 1 removes GitHub's "<owner>-<repo>-<sha>/" wrapper directory.
    tar.extract({ cwd: destDir, strip: 1 }),
  );
}

/** Every regular file under `rootDir`, as POSIX paths relative to it. Symlinks are skipped. */
export async function listFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const child of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) {
        await walk(join(dir, child.name), path);
      } else if (child.isFile()) {
        files.push(path);
      }
      // Symlinks are neither: the archive is untrusted, and a link could point
      // anywhere on this machine.
    }
  };
  const info = await lstat(rootDir);
  if (info.isDirectory()) await walk(rootDir, "");
  return files;
}
