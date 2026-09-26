import { describe, expect, it } from "vitest";
import {
  branchFromRef,
  changedFiles,
  commitInfo,
  hasSkipCiKeyword,
  screenPush,
  shouldDeploy,
} from './push-filter';
import { PushPayload, ZERO_SHA } from './push-payload';

/** A minimal deployable push; each test overrides only what it cares about. */
const push = (overrides: Partial<PushPayload> = {}): PushPayload => ({
  ref: 'refs/heads/main',
  after: 'a'.repeat(40),
  repository: { id: 123, full_name: 'samyak/app' },
  head_commit: { id: 'a'.repeat(40), message: 'feat: add thing' },
  commits: [],
  ...overrides,
});

describe('branchFromRef', () => {
  it('extracts the branch from a heads ref', () => {
    expect(branchFromRef('refs/heads/main')).toBe('main');
    expect(branchFromRef('refs/heads/feature/nested/name')).toBe('feature/nested/name');
  });

  it('rejects tags and anything that is not a branch', () => {
    expect(branchFromRef('refs/tags/v1.0.0')).toBeNull();
    expect(branchFromRef('refs/pull/7/merge')).toBeNull();
    expect(branchFromRef('refs/heads/')).toBeNull();
    expect(branchFromRef(undefined)).toBeNull();
    expect(branchFromRef('')).toBeNull();
  });
});

describe('hasSkipCiKeyword', () => {
  it.each(['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]'])(
    'detects %s',
    (keyword) => {
      expect(hasSkipCiKeyword(`chore: tidy up ${keyword}`)).toBe(true);
    },
  );

  it('is case insensitive', () => {
    expect(hasSkipCiKeyword('Docs only [SKIP CI]')).toBe(true);
  });

  it('does not fire on ordinary messages', () => {
    expect(hasSkipCiKeyword('fix: skip the retry when ci is green')).toBe(false);
    expect(hasSkipCiKeyword(undefined)).toBe(false);
    expect(hasSkipCiKeyword(null)).toBe(false);
  });
});

describe('changedFiles', () => {
  it('flattens added, modified and removed across every commit', () => {
    const files = changedFiles(
      push({
        commits: [
          { added: ['a.ts'], modified: ['b.ts'], removed: [] },
          { added: [], modified: ['c.ts'], removed: ['d.ts'] },
        ],
      }),
    );
    expect(files.sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });

  it('survives commits with missing arrays', () => {
    expect(changedFiles(push({ commits: [{}, { added: ['x'] }] }))).toEqual(['x']);
    expect(changedFiles(push({ commits: undefined }))).toEqual([]);
  });
});

describe('shouldDeploy', () => {
  it('deploys everything when no watch paths are configured', () => {
    expect(shouldDeploy([], ['anything.txt'])).toBe(true);
    expect(shouldDeploy(null, ['anything.txt'])).toBe(true);
    expect(shouldDeploy(undefined, [])).toBe(true);
  });

  it('deploys when a changed file matches a glob', () => {
    expect(shouldDeploy(['apps/api/**'], ['apps/api/src/main.ts'])).toBe(true);
    expect(shouldDeploy(['**/*.ts'], ['deep/nested/file.ts'])).toBe(true);
  });

  it('skips when nothing matches', () => {
    expect(shouldDeploy(['apps/api/**'], ['apps/web/page.tsx'])).toBe(false);
    expect(shouldDeploy(['*.md'], ['src/index.ts'])).toBe(false);
  });

  it('matches if ANY one of several patterns hits', () => {
    expect(shouldDeploy(['apps/api/**', 'shared/**'], ['shared/util.ts'])).toBe(true);
  });

  // The important one. GitHub truncates commits[] at 20 entries and omits it
  // for some forced pushes, so an empty list means "unknown", not "nothing".
  it('FAILS OPEN when the changed-file list is empty or unusable', () => {
    expect(shouldDeploy(['apps/api/**'], [])).toBe(true);
    expect(shouldDeploy(['apps/api/**'], null)).toBe(true);
    expect(shouldDeploy(['apps/api/**'], undefined)).toBe(true);
    expect(shouldDeploy(['apps/api/**'], [null, undefined, ''])).toBe(true);
  });
});

describe('screenPush', () => {
  it('accepts an ordinary branch push', () => {
    expect(screenPush(push())).toEqual({ deployable: true, branch: 'main', repoId: 123 });
  });

  it('rejects tag pushes', () => {
    expect(screenPush(push({ ref: 'refs/tags/v1.0.0' }))).toEqual({
      deployable: false,
      reason: 'not-a-branch',
    });
  });

  it('rejects branch deletions, by flag and by zero sha', () => {
    expect(screenPush(push({ deleted: true }))).toEqual({
      deployable: false,
      reason: 'branch-deleted',
    });
    expect(screenPush(push({ after: ZERO_SHA }))).toEqual({
      deployable: false,
      reason: 'zero-sha',
    });
  });

  it('rejects a skip-ci head commit', () => {
    expect(screenPush(push({ head_commit: { message: 'docs [skip ci]' } }))).toEqual({
      deployable: false,
      reason: 'skip-ci-keyword',
    });
  });

  it('rejects a payload with no numeric repository id', () => {
    expect(screenPush(push({ repository: { full_name: 'samyak/app' } }))).toEqual({
      deployable: false,
      reason: 'no-repository-id',
    });
  });

  it('does not throw on an empty object', () => {
    expect(screenPush({} as PushPayload).deployable).toBe(false);
  });
});

describe('commitInfo', () => {
  it('prefers head_commit, falling back to after', () => {
    expect(commitInfo(push()).commitSha).toBe('a'.repeat(40));
    expect(commitInfo(push({ head_commit: null })).commitSha).toBe('a'.repeat(40));
  });

  it('walks the author fallback chain', () => {
    expect(commitInfo(push({ sender: { login: 'octocat' } })).commitAuthor).toBe('octocat');
    expect(
      commitInfo(push({ head_commit: { author: { username: 'from-commit' } } })).commitAuthor,
    ).toBe('from-commit');
    expect(commitInfo(push({ pusher: { name: 'from-pusher' } })).commitAuthor).toBe('from-pusher');
    expect(commitInfo(push()).commitAuthor).toBeNull();
  });
});
