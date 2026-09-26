import micromatch from 'micromatch';
import { PushPayload, ZERO_SHA } from './push-payload';

/**
 * Pure predicates deciding whether a push should produce a deployment.
 *
 * Deliberately free of Nest, Prisma and I/O so the decision logic can be tested
 * exhaustively without a database, a Docker daemon or a running app. The
 * orchestration that uses them lives in DeploymentsService.
 */

/**
 * Commit-message markers that suppress a deploy, matching the set GitHub
 * Actions honours so the same commit behaves the same way in both.
 *
 * @link https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/skipping-workflow-runs
 */
export const SKIP_CI_KEYWORDS = [
  '[skip ci]',
  '[ci skip]',
  '[no ci]',
  '[skip actions]',
  '[actions skip]',
] as const;

export function hasSkipCiKeyword(message: string | undefined | null): boolean {
  const lowered = (message ?? '').toLowerCase();
  return SKIP_CI_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

/** "refs/heads/main" -> "main". Returns null for tags and any other ref type. */
export function branchFromRef(ref: string | undefined | null): string | null {
  if (!ref || !ref.startsWith('refs/heads/')) {
    return null;
  }
  const branch = ref.slice('refs/heads/'.length);
  return branch.length > 0 ? branch : null;
}

/**
 * Every path touched by the push: added, modified and removed, across all
 * commits. Removals count - deleting a watched file is a change to it.
 */
export function changedFiles(payload: PushPayload): string[] {
  return (payload.commits ?? []).flatMap((commit) => [
    ...(commit?.added ?? []),
    ...(commit?.modified ?? []),
    ...(commit?.removed ?? []),
  ]);
}

/**
 * Does this push touch anything the project watches?
 *
 * Fails OPEN when the file list is empty, and that is not an oversight. GitHub
 * truncates `commits[]` at 20 entries and omits it entirely for some forced
 * pushes, so an empty list means "unknown", not "nothing changed". Failing
 * closed there would silently skip deploying a large merge - the worst failure
 * mode available, because it looks exactly like nothing happened.
 *
 * The precise fix, for later: GET /repos/{owner}/{repo}/compare/{base}...{head}
 * returns the true file list regardless of size.
 */
export function shouldDeploy(
  watchPaths: string[] | null | undefined,
  files: (string | null | undefined)[] | null | undefined,
): boolean {
  if (!watchPaths || watchPaths.length === 0) {
    return true;
  }
  const known = (files ?? []).filter((f): f is string => typeof f === 'string' && f.length > 0);
  if (known.length === 0) {
    return true;
  }
  return micromatch(known, watchPaths).length > 0;
}

export type SkipReason =
  | 'not-a-branch'
  | 'branch-deleted'
  | 'zero-sha'
  | 'skip-ci-keyword'
  | 'no-repository-id';

/**
 * The payload-only gates, run before any database work. Returns the branch to
 * match on, or the reason this push is not deployable.
 *
 * Kept separate from the project lookup so the cheap checks stay cheap and the
 * expensive one runs at most once.
 */
export function screenPush(
  payload: PushPayload,
): { deployable: true; branch: string; repoId: number } | { deployable: false; reason: SkipReason } {
  const branch = branchFromRef(payload.ref);
  if (!branch) {
    return { deployable: false, reason: 'not-a-branch' };
  }
  if (payload.deleted === true) {
    return { deployable: false, reason: 'branch-deleted' };
  }
  if (!payload.after || payload.after === ZERO_SHA) {
    return { deployable: false, reason: 'zero-sha' };
  }
  if (hasSkipCiKeyword(payload.head_commit?.message)) {
    return { deployable: false, reason: 'skip-ci-keyword' };
  }
  const repoId = payload.repository?.id;
  if (typeof repoId !== 'number') {
    return { deployable: false, reason: 'no-repository-id' };
  }
  return { deployable: true, branch, repoId };
}

/** Best-effort attribution for the deployment record. */
export function commitInfo(payload: PushPayload): {
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
} {
  return {
    commitSha: payload.head_commit?.id ?? payload.after ?? null,
    commitMessage: payload.head_commit?.message ?? null,
    commitAuthor:
      payload.sender?.login ??
      payload.head_commit?.author?.username ??
      payload.pusher?.name ??
      null,
  };
}
