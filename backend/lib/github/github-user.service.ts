import type { PrismaClient } from "@prisma/client";
import { HttpError, notFound } from "@/lib/api/http-error";
import {
  loadGithubOAuthConfig,
  OAuthTokenError,
  refreshUserToken,
  type GithubOAuthConfig,
} from "@/lib/auth/github-oauth";
import { CLEARED_TOKEN_COLUMNS, sealTokenColumns } from "@/lib/auth/github-tokens";
import { open, SecretBoxError } from "@/lib/crypto/secret-box";
import { describe, GithubError, request, type GithubApiResponse } from "./http";
import type { ParsedRepo } from "./repo-url";

export interface GithubInstallation {
  id: string;
  /** Login of the user or organisation the App is installed on. */
  account: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  /** GitHub's settings page for this installation, where repositories are added. */
  manageUrl: string;
}

export interface GithubRepository {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  installationId: string;
  pushedAt: string | null;
}

export interface RepositoryListing {
  installations: GithubInstallation[];
  repositories: GithubRepository[];
  /** At least one installation has more repositories than were read. */
  truncated: boolean;
}

export interface BranchListing {
  defaultBranch: string;
  branches: Array<{ name: string; protected: boolean }>;
}

const PER_PAGE = 100;
const MAX_REPOSITORY_PAGES = 5;
const MAX_BRANCH_PAGES = 3;
/** Refresh this long before expiry, so a token never lapses mid-request. */
const REFRESH_MARGIN_MS = 60_000;

export const githubReconnectRequired = () =>
  new HttpError(
    "Your GitHub connection has expired or was revoked. Reconnect GitHub to continue.",
    409,
    "github_reconnect_required",
  );

type StoredConnection = {
  id: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
};

type ApiInstallation = {
  id: number;
  account: { login: string; type: string } | null;
  repository_selection: "all" | "selected";
  html_url: string;
};

type ApiRepository = {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
  owner: { login: string };
};

/**
 * GitHub calls made as the signed-in user, with the user-to-server token
 * stored at sign-in.
 *
 * The App's installation token answers "can the App reach this repository?";
 * this answers "can this *user*?" - which installations they see, which of
 * their repositories the App is on, and whether a repository they ask to
 * connect is one they may read. Nothing is cached in our database: GitHub
 * stays the authority, including on organisation membership.
 */
export class GithubUserService {
  /**
   * One refresh in flight per user. Refresh tokens are single-use, so two
   * concurrent refreshes would race, and the loser's token would be rejected
   * and force a needless reconnect.
   */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly loadConfig: () => GithubOAuthConfig = loadGithubOAuthConfig,
  ) {}

  // -------------------------------------------------------------- token ----

  /** A usable access token for this user, refreshed if it is about to expire. */
  async getToken(userId: string): Promise<string> {
    const connection = await this.findConnection(userId);
    if (!connection?.accessTokenEnc) {
      throw githubReconnectRequired();
    }
    if (!this.needsRefresh(connection)) {
      return this.openToken(connection, connection.accessTokenEnc);
    }

    let pending = this.refreshing.get(userId);
    if (!pending) {
      pending = this.refresh(userId).finally(() => this.refreshing.delete(userId));
      this.refreshing.set(userId, pending);
    }
    return pending;
  }

  private async refresh(userId: string): Promise<string> {
    // Re-read inside the single flight: a refresh that finished between the
    // caller's read and this one has already rotated the pair, and the
    // refresh token the caller saw is spent.
    const connection = await this.findConnection(userId);
    if (!connection?.accessTokenEnc) {
      throw githubReconnectRequired();
    }
    if (!this.needsRefresh(connection)) {
      return this.openToken(connection, connection.accessTokenEnc);
    }

    const refreshExpired =
      connection.refreshTokenExpiresAt !== null &&
      connection.refreshTokenExpiresAt.getTime() <= Date.now();
    if (!connection.refreshTokenEnc || refreshExpired) {
      await this.forget(connection.id);
      throw githubReconnectRequired();
    }

    let tokens;
    try {
      tokens = await refreshUserToken(
        this.loadConfig(),
        this.openToken(connection, connection.refreshTokenEnc),
      );
    } catch (error) {
      if (error instanceof OAuthTokenError) {
        // GitHub refused the refresh token: revoked, or already used.
        await this.forget(connection.id);
        throw githubReconnectRequired();
      }
      if (error instanceof HttpError) {
        throw error;
      }
      throw new GithubError(`Could not refresh the GitHub token: ${(error as Error).message}`, 502);
    }

    await this.prisma.gitHubConnection.update({
      where: { id: connection.id },
      data: sealTokenColumns(tokens),
    });
    return tokens.accessToken;
  }

  private findConnection(userId: string): Promise<StoredConnection | null> {
    return this.prisma.gitHubConnection.findFirst({
      where: { userId, accessTokenEnc: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        accessTokenEnc: true,
        refreshTokenEnc: true,
        accessTokenExpiresAt: true,
        refreshTokenExpiresAt: true,
      },
    });
  }

  private needsRefresh(connection: StoredConnection): boolean {
    return (
      connection.accessTokenExpiresAt !== null &&
      connection.accessTokenExpiresAt.getTime() - Date.now() <= REFRESH_MARGIN_MS
    );
  }

  /** A value that no longer opens (key changed, row edited) is as good as no token. */
  private openToken(connection: StoredConnection, sealed: string): string {
    try {
      return open(sealed);
    } catch (error) {
      if (error instanceof SecretBoxError) {
        console.warn(`[github-user] Stored token for connection ${connection.id} cannot be opened.`);
        void this.forget(connection.id).catch(() => undefined);
        throw githubReconnectRequired();
      }
      throw error;
    }
  }

  private async forget(connectionId: string): Promise<void> {
    await this.prisma.gitHubConnection.update({
      where: { id: connectionId },
      data: CLEARED_TOKEN_COLUMNS,
    });
  }

  /** A GET as the user. A 401 means the token was revoked behind our back. */
  private async get<T>(userId: string, path: string): Promise<GithubApiResponse<T>> {
    const token = await this.getToken(userId);
    const response = await request<T>("GET", path, { authorization: `Bearer ${token}` });
    if (response.status === 401) {
      await this.prisma.gitHubConnection.updateMany({
        where: { userId },
        data: CLEARED_TOKEN_COLUMNS,
      });
      throw githubReconnectRequired();
    }
    return response;
  }

  // ---------------------------------------------------------- listings ----

  /** Installations of this App the user can see: their own, and their organisations'. */
  async listInstallations(userId: string): Promise<GithubInstallation[]> {
    const response = await this.get<{ installations: ApiInstallation[] }>(
      userId,
      `/user/installations?per_page=${PER_PAGE}`,
    );
    if (response.status !== 200) {
      throw new GithubError(`GitHub API error while listing installations: ${describe(response)}`, 502);
    }

    return response.body.installations.map((installation) => ({
      id: String(installation.id),
      account: installation.account?.login ?? "unknown",
      accountType: installation.account?.type ?? "User",
      repositorySelection: installation.repository_selection,
      manageUrl: installation.html_url,
    }));
  }

  /**
   * Every repository the user can reach through each installation, up to
   * MAX_REPOSITORY_PAGES pages per installation; `truncated` says when that
   * cap cut a list short.
   */
  async listRepositories(userId: string): Promise<RepositoryListing> {
    const installations = await this.listInstallations(userId);
    const lists = await Promise.all(
      installations.map((installation) => this.listInstallationRepositories(userId, installation.id)),
    );

    return {
      installations,
      repositories: lists.flatMap((list) => list.repositories),
      truncated: lists.some((list) => list.truncated),
    };
  }

  private async listInstallationRepositories(
    userId: string,
    installationId: string,
  ): Promise<{ repositories: GithubRepository[]; truncated: boolean }> {
    const repositories: GithubRepository[] = [];
    let total = 0;

    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
      const response = await this.get<{ total_count: number; repositories: ApiRepository[] }>(
        userId,
        `/user/installations/${installationId}/repositories?per_page=${PER_PAGE}&page=${page}`,
      );
      if (response.status === 404) {
        // Uninstalled between the two requests; it simply has nothing to list.
        return { repositories, truncated: false };
      }
      if (response.status !== 200) {
        throw new GithubError(
          `GitHub API error while listing repositories: ${describe(response)}`,
          502,
        );
      }

      total = response.body.total_count;
      for (const repo of response.body.repositories) {
        repositories.push({
          id: repo.id,
          fullName: repo.full_name,
          owner: repo.owner.login,
          name: repo.name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          installationId,
          pushedAt: repo.pushed_at,
        });
      }
      if (response.body.repositories.length < PER_PAGE || repositories.length >= total) {
        break;
      }
    }

    return { repositories, truncated: total > repositories.length };
  }

  /**
   * Can this user read the repository? GitHub answers 404 both for a repository
   * that does not exist and for one the user cannot see, which is exactly the
   * question - and a user token's view is already narrowed to repositories the
   * App is installed on, or that are public.
   */
  async canAccess(userId: string, repo: ParsedRepo): Promise<boolean> {
    const response = await this.get<unknown>(userId, `/repos/${repo.owner}/${repo.repo}`);
    if (response.status === 200) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }
    throw new GithubError(
      `GitHub API error while checking access to ${repo.fullName}: ${describe(response)}`,
      502,
    );
  }

  /** The repository's branches, default first if the page cap would have hidden it. */
  async listBranches(userId: string, repo: ParsedRepo): Promise<BranchListing> {
    const repoResponse = await this.get<{ default_branch: string }>(
      userId,
      `/repos/${repo.owner}/${repo.repo}`,
    );
    if (repoResponse.status === 404) {
      throw notFound(`Repository ${repo.fullName} was not found, or you cannot access it.`);
    }
    if (repoResponse.status !== 200) {
      throw new GithubError(
        `GitHub API error while reading ${repo.fullName}: ${describe(repoResponse)}`,
        502,
      );
    }
    const defaultBranch = repoResponse.body.default_branch;

    const branches: BranchListing["branches"] = [];
    for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
      const response = await this.get<Array<{ name: string; protected: boolean }>>(
        userId,
        `/repos/${repo.owner}/${repo.repo}/branches?per_page=${PER_PAGE}&page=${page}`,
      );
      if (response.status !== 200) {
        throw new GithubError(
          `GitHub API error while listing branches of ${repo.fullName}: ${describe(response)}`,
          502,
        );
      }
      branches.push(...response.body.map((branch) => ({ name: branch.name, protected: branch.protected })));
      if (response.body.length < PER_PAGE) {
        break;
      }
    }

    if (!branches.some((branch) => branch.name === defaultBranch)) {
      branches.unshift({ name: defaultBranch, protected: false });
    }
    return { defaultBranch, branches };
  }
}
