/**
 * GitHub API service for fetching repository file trees and file contents.
 *
 * Uses the GitHub REST API v3 (api.github.com).
 * No SDK dependency — plain fetch calls.
 */

const GITHUB_API_BASE = "https://api.github.com";

export type GitHubTreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
};

export type GitHubTree = {
  sha: string;
  tree: GitHubTreeEntry[];
  truncated: boolean;
};

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

function headers(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Fetches the full recursive file tree for a repository.
 */
export async function getRepositoryTree(
  repoFullName: string,
  branch: string,
  accessToken: string,
): Promise<GitHubTree> {
  const url = `${GITHUB_API_BASE}/repos/${repoFullName}/git/trees/${branch}?recursive=1`;

  const response = await fetch(url, { headers: headers(accessToken) });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GitHubApiError(
      `Failed to fetch tree for ${repoFullName}@${branch}: ${response.status} ${body}`,
      response.status,
      url,
    );
  }

  const data = (await response.json()) as GitHubTree;
  return data;
}

/**
 * Fetches the raw content of a single file from a repository.
 */
export async function getFileContent(
  repoFullName: string,
  path: string,
  branch: string,
  accessToken: string,
): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${repoFullName}/contents/${path}?ref=${branch}`;

  const response = await fetch(url, {
    headers: {
      ...headers(accessToken),
      Accept: "application/vnd.github.v3.raw",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GitHubApiError(
      `Failed to fetch ${path} from ${repoFullName}@${branch}: ${response.status} ${body}`,
      response.status,
      url,
    );
  }

  return response.text();
}
