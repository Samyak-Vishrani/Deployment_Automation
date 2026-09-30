import { createSign } from "node:crypto";
import { Readable } from "node:stream";
import { loadGithubConfig, type GithubConfig } from "./github.config";
import type { ParsedRepo } from "./repo-url";

const GITHUB_API = "https://api.github.com";

/** An error carrying an HTTP status we are happy to surface to the frontend. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

/** The repository metadata a project is built from. */
export interface RepoMetadata {
  /** Numeric id. The routing key an incoming push is matched against. */
  id: number;
  fullName: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
  installationId: string;
}

interface GithubApiResponse<T> {
  status: number;
  body: T;
}

/**
 * GitHub App authentication and the handful of API calls the deploy pipeline
 * makes.
 *
 * Distinct from github.service.ts, which holds the token-agnostic tree and
 * file-content reads the analysis phase uses. This one authenticates as the App
 * installation, which is what lets a webhook-triggered deployment - and the
 * analysis - reach a repository with no user token stored anywhere.
 *
 * There is deliberately no webhook management here. A GitHub App has a single
 * webhook URL, configured on the App itself, which already receives events for
 * every installed repository - so there is nothing to create per project, and
 * nothing to clean up when a project is deleted.
 */
export class GithubAppService {
  /**
   * Resolved lazily rather than in the constructor. A Next.js route module is
   * evaluated the moment anything in its import graph is touched, so throwing
   * here on a missing GITHUB_APP_ID would take down unrelated endpoints - the
   * health check included - instead of only the ones that need GitHub.
   */
  private cachedConfig: GithubConfig | null = null;
  /** Cached installation tokens per installation id (GitHub tokens live ~1 hour). */
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  getConfig(): GithubConfig {
    if (!this.cachedConfig) {
      this.cachedConfig = loadGithubConfig();
    }
    return this.cachedConfig;
  }

  /** Where a user installs this GitHub App on their repositories. */
  get installUrl(): string {
    return `https://github.com/apps/${this.getConfig().appSlug}/installations/new`;
  }

  // ---------------------------------------------------------------- auth ----

  /**
   * A short-lived JWT signed with the GitHub App private key. It authenticates
   * the *app itself* (not an installation) and is only used to mint
   * installation access tokens.
   */
  private createAppJwt(): string {
    const config = this.getConfig();
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iat: now - 60, // allow for clock drift
      exp: now + 9 * 60, // GitHub rejects anything over 10 minutes
      iss: config.appId,
    };

    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode(header)}.${encode(payload)}`;

    try {
      const signature = createSign("RSA-SHA256")
        .update(unsigned)
        .sign(config.privateKey, "base64url");
      return `${unsigned}.${signature}`;
    } catch {
      // Never log or echo the key itself.
      throw new GithubError(
        "Could not sign the GitHub App JWT. Check that GITHUB_PRIVATE_KEY holds the complete PEM private key.",
        500,
      );
    }
  }

  /** Finds the installation of this app that has access to the repository. */
  async resolveInstallationId(repo: ParsedRepo): Promise<string> {
    const config = this.getConfig();
    if (config.installationId) {
      return config.installationId;
    }

    const jwt = this.createAppJwt();
    const response = await this.request<{ id: number }>(
      "GET",
      `/repos/${repo.owner}/${repo.repo}/installation`,
      { authorization: `Bearer ${jwt}` },
    );

    if (response.status === 404) {
      throw new GithubError(
        `The GitHub App is not installed on ${repo.fullName} (or the repository does not exist). ` +
          `Install it here: ${this.installUrl}`,
        404,
      );
    }
    if (response.status === 401) {
      throw new GithubError(
        "GitHub rejected the App credentials. Check GITHUB_APP_ID and GITHUB_PRIVATE_KEY.",
        500,
      );
    }
    if (response.status !== 200) {
      throw new GithubError(
        `GitHub API error while looking up the app installation: ${this.describe(response)}`,
        502,
      );
    }

    return String(response.body.id);
  }

  /**
   * Exchanges the app JWT for an installation access token (valid ~1 hour).
   *
   * Public because the deployment executor needs one to download source
   * tarballs. Callers must treat the result as a secret: it must never reach a
   * command line, a log line, or an error message.
   */
  async getInstallationToken(installationId: string): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 60_000) {
      return cached.token;
    }

    const jwt = this.createAppJwt();
    const response = await this.request<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      { authorization: `Bearer ${jwt}` },
    );

    if (response.status === 404) {
      throw new GithubError(
        `GitHub App installation ${installationId} was not found. Check GITHUB_INSTALLATION_ID, ` +
          "or remove it from .env to let the backend detect the installation automatically.",
        404,
      );
    }
    if (response.status === 401) {
      throw new GithubError(
        "GitHub rejected the App credentials. Check GITHUB_APP_ID and GITHUB_PRIVATE_KEY.",
        500,
      );
    }
    if (response.status !== 201) {
      throw new GithubError(
        `GitHub API error while creating an installation token: ${this.describe(response)}`,
        502,
      );
    }

    this.tokenCache.set(installationId, {
      token: response.body.token,
      expiresAt: new Date(response.body.expires_at).getTime(),
    });
    return response.body.token;
  }

  // ------------------------------------------------------------ metadata ----

  /**
   * Reads the repository, returning the fields a Project is built from.
   *
   * The numeric id is the important one: it is what incoming pushes are
   * matched against, and unlike "owner/repo" it survives renames and transfers.
   */
  async getRepoMetadata(repo: ParsedRepo): Promise<RepoMetadata> {
    const installationId = await this.resolveInstallationId(repo);
    const token = await this.getInstallationToken(installationId);

    const response = await this.request<{
      id: number;
      full_name: string;
      name: string;
      default_branch: string;
      private: boolean;
      owner: { login: string };
    }>("GET", `/repos/${repo.owner}/${repo.repo}`, {
      authorization: `Bearer ${token}`,
    });

    if (response.status === 404) {
      throw new GithubError(
        `Repository ${repo.fullName} does not exist, or the GitHub App installation cannot access it. ` +
          `Check the repository selection here: ${this.installUrl}`,
        404,
      );
    }
    if (response.status !== 200) {
      throw new GithubError(
        `GitHub API error while reading ${repo.fullName}: ${this.describe(response)}`,
        502,
      );
    }

    return {
      id: response.body.id,
      fullName: response.body.full_name,
      owner: response.body.owner?.login ?? repo.owner,
      repo: response.body.name ?? repo.repo,
      defaultBranch: response.body.default_branch,
      private: Boolean(response.body.private),
      installationId,
    };
  }

  /** Does this branch exist? Used to reject a project pointed at a typo. */
  async branchExists(repo: ParsedRepo, branch: string): Promise<boolean> {
    const installationId = await this.resolveInstallationId(repo);
    const token = await this.getInstallationToken(installationId);
    const response = await this.request<unknown>(
      "GET",
      `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(branch)}`,
      { authorization: `Bearer ${token}` },
    );
    return response.status === 200;
  }

  /**
   * The commit a branch currently points at.
   *
   * The analysis pins every read to this SHA: a branch name can move between
   * the tree request and the file reads, a SHA cannot.
   */
  async getBranchHeadSha(
    repo: ParsedRepo,
    branch: string,
    installationId?: string,
  ): Promise<string> {
    const id = installationId ?? (await this.resolveInstallationId(repo));
    const token = await this.getInstallationToken(id);
    const response = await this.request<{ commit?: { sha?: string } }>(
      "GET",
      `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(branch)}`,
      { authorization: `Bearer ${token}` },
    );

    if (response.status === 404) {
      throw new GithubError(
        `Branch "${branch}" does not exist on ${repo.fullName}, or the GitHub App installation cannot access the repository.`,
        404,
      );
    }
    if (response.status !== 200 || !response.body.commit?.sha) {
      throw new GithubError(
        `GitHub API error while reading branch "${branch}" of ${repo.fullName}: ${this.describe(response)}`,
        502,
      );
    }

    return response.body.commit.sha;
  }

  // -------------------------------------------------------------- source ----

  /**
   * Opens a stream of the repository at an exact commit, as a gzipped tarball.
   *
   * Why a tarball rather than a git clone: the token travels in a header and
   * never reaches a command line, where the process list - or an error message
   * echoed into the build log we stream to a browser - could expose it. It also
   * removes the git binary from the deploy path, which on Windows sidesteps
   * autocrlf mangling shell scripts, Git Credential Manager opening a GUI
   * prompt that blocks the build, and read-only packfiles defeating cleanup.
   */
  async openSourceTarball(
    repo: ParsedRepo,
    ref: string,
    installationId?: string,
  ): Promise<Readable> {
    const id = installationId ?? (await this.resolveInstallationId(repo));
    const token = await this.getInstallationToken(id);
    const url = `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/tarball/${encodeURIComponent(ref)}`;

    // redirect: 'manual' is load-bearing. GitHub answers 302 with a pre-signed
    // codeload.github.com URL, and undici strips the Authorization header on a
    // cross-origin redirect. Auto-follow happens to work because the target is
    // pre-signed, but relying on that silently is how this becomes a mystery
    // 404 later, so the hop is made explicit.
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "orbitops-deploy",
          authorization: `Bearer ${token}`,
        },
      });
    } catch (error) {
      throw new GithubError(
        `Could not reach the GitHub API: ${(error as Error).message}`,
        502,
      );
    }

    let download = response;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new GithubError(
          "GitHub redirected the tarball request but sent no Location header.",
          502,
        );
      }
      // Deliberately no Authorization header: the codeload URL carries its own
      // credential, and forwarding ours to another origin would leak it.
      download = await fetch(location, { headers: { "user-agent": "orbitops-deploy" } });
    }

    if (!download.ok || !download.body) {
      throw new GithubError(
        `Could not download source for ${repo.fullName} at ${ref}: HTTP ${download.status}.`,
        download.status === 404 ? 404 : 502,
      );
    }

    return Readable.fromWeb(download.body as never);
  }

  // ------------------------------------------------------------- plumbing ---

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<GithubApiResponse<T>> {
    let response: Response;
    try {
      response = await fetch(`${GITHUB_API}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "orbitops-deploy",
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new GithubError(
        `Could not reach the GitHub API: ${(error as Error).message}`,
        502,
      );
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    return { status: response.status, body: parsed as T };
  }

  /** Safe, credential-free description of a failed GitHub response. */
  private describe(response: GithubApiResponse<unknown>): string {
    const message = (response.body as { message?: string } | null)?.message ?? "";
    return `HTTP ${response.status}${message ? ` - ${message}` : ""}`;
  }
}
