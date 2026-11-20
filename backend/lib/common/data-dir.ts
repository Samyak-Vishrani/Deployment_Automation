import { isAbsolute, resolve } from "node:path";

/**
 * Resolves DATA_DIR against the backend folder.
 *
 * Next.js always starts with process.cwd() at the app root - the folder holding
 * next.config.ts - regardless of where npm was invoked from, so it is the
 * stable anchor here. Moved out of the old deployment-logs.service (Phase 12):
 * build logs now live in backend/logs, but Docker work dirs and analysis
 * scratch space still use this folder.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DATA_DIR?.trim();
  if (configured) {
    return isAbsolute(configured)
      ? configured
      : resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  }
  // turbopackIgnore, or the bundler's static analysis sees an unbounded
  // process.cwd() read and traces the entire project into the server output.
  return resolve(/* turbopackIgnore: true */ process.cwd(), "data");
}
