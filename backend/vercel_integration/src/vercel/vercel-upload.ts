import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError } from "../http/provider-error";
import { expectOk, vercelRequest, type VercelContext } from "./vercel-http";

/**
 * The upload half of Vercel's file-based deploy: hash every file, then send
 * only the ones Vercel does not already have.
 *
 * Used when Vercel's GitHub app cannot read the repository. The whole repo is
 * uploaded, not just the component's folder, so monorepo workspaces resolve;
 * the project's rootDirectory tells Vercel where to build.
 */

export const MAX_FILES = 15_000;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 6;

/** Never uploaded: VCS data, dependencies, local build output and real env files. */
const IGNORED_DIRS = new Set([".git", "node_modules", ".vercel", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo"]);

export interface VercelFile {
  /** POSIX path relative to the repository root. */
  file: string;
  sha: string;
  size: number;
}

export function isIgnored(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => IGNORED_DIRS.has(segment))) return true;
  const name = segments[segments.length - 1];
  // .env, .env.local, .env.production... but the example files are documentation.
  return /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name);
}

export async function hashFiles(rootDir: string, paths: string[]): Promise<VercelFile[]> {
  const kept = paths.filter((path) => !isIgnored(path)).sort();
  if (kept.length > MAX_FILES) {
    throw new ProviderError(
      `The repository has ${kept.length} files to upload; Vercel accepts at most ${MAX_FILES}. ` +
        "Install Vercel's GitHub app on this repository so Vercel can read it directly instead.",
      400,
      "vercel_upload_too_large",
    );
  }

  const files: VercelFile[] = [];
  let total = 0;
  for (const path of kept) {
    const absolute = join(rootDir, ...path.split("/"));
    const { size } = await stat(absolute);
    total += size;
    if (total > MAX_TOTAL_BYTES) {
      throw new ProviderError(
        `The repository is larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MB, too big to upload. ` +
          "Install Vercel's GitHub app on this repository so Vercel can read it directly instead.",
        400,
        "vercel_upload_too_large",
      );
    }
    const sha = createHash("sha1").update(await readFile(absolute)).digest("hex");
    files.push({ file: path, sha, size });
  }
  return files;
}

/** The SHAs Vercel says it is missing, from a `400 missing_files` response. */
export function missingShas(body: unknown): string[] {
  const error = (body as { error?: { code?: string; missing?: unknown } } | null)?.error;
  if (error?.code !== "missing_files" || !Array.isArray(error.missing)) return [];
  return error.missing.filter((sha): sha is string => typeof sha === "string");
}

/** Uploads the files whose SHA is in `shas`, a few at a time. */
export async function uploadFiles(
  ctx: VercelContext,
  rootDir: string,
  files: VercelFile[],
  shas: Iterable<string>,
): Promise<number> {
  const wanted = new Set(shas);
  // Identical files share a SHA; upload each blob once.
  const bySha = new Map<string, VercelFile>();
  for (const file of files) {
    if (wanted.has(file.sha) && !bySha.has(file.sha)) bySha.set(file.sha, file);
  }
  const queue = [...bySha.values()];

  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const content = await readFile(join(rootDir, ...file.file.split("/")));
      const response = await vercelRequest(ctx, "POST", "/v2/files", {
        rawBody: content,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(file.size),
          "x-vercel-digest": file.sha,
        },
        fetch: { retryOnNetworkError: true, timeoutMs: 120_000 },
      });
      expectOk(response, `uploading ${file.file}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));
  return bySha.size;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
