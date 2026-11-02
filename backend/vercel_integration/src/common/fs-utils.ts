// Copied from backend/lib/common/fs-utils.ts. This service never imports from the main backend,
// so it builds and deploys on its own. Keep the two copies in step.

import { chmod, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Recursively deletes a directory, coping with Windows.
 *
 * `fs.rm({ force: true })` is not enough on Windows: `force` only suppresses
 * ENOENT, it does not clear the read-only attribute. Extracted archives and git
 * packfiles routinely carry read-only entries, and deleting one fails with
 * EPERM - which would leak a build workspace on every single deployment.
 *
 * Retries also matter here: antivirus and the file indexer briefly hold handles
 * on freshly written files, producing transient EBUSY/EPERM.
 */
export async function removeDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
      throw error;
    }
  }

  // Second attempt: clear read-only attributes across the tree, then retry.
  await makeWritable(dir);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function makeWritable(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return; // Vanished underneath us; nothing to do.
  }

  try {
    await chmod(path, 0o666);
  } catch {
    // Best effort - a failure here just means the retry may still fail.
  }

  if (info.isDirectory()) {
    // Directories need the execute bit to be traversable.
    try {
      await chmod(path, 0o777);
    } catch {
      /* best effort */
    }
    let entries: string[] = [];
    try {
      entries = await readdir(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      await makeWritable(join(path, entry));
    }
  }
}
