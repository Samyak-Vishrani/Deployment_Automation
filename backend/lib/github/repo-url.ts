/**
 * Parses and validates a GitHub repository URL.
 *
 * Accepted forms (with or without protocol / trailing ".git" / trailing slash):
 *   https://github.com/owner/repo
 *   http://www.github.com/owner/repo.git
 *   github.com/owner/repo/
 */

export interface ParsedRepo {
  owner: string;
  repo: string;
  /** "owner/repo" */
  fullName: string;
}

// GitHub owner/repo naming rules (kept intentionally simple but strict).
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export class InvalidRepoUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRepoUrlError";
  }
}

export function parseRepoUrl(rawUrl: string): ParsedRepo {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new InvalidRepoUrlError("Repository URL is required.");
  }

  const trimmed = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new InvalidRepoUrlError(`"${rawUrl}" is not a valid URL.`);
  }

  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    throw new InvalidRepoUrlError(
      `Only github.com repository URLs are supported (got "${url.hostname}").`,
    );
  }

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) {
    throw new InvalidRepoUrlError(
      "Repository URL must look like https://github.com/owner/repository.",
    );
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");

  if (!OWNER_PATTERN.test(owner)) {
    throw new InvalidRepoUrlError(`"${owner}" is not a valid GitHub owner name.`);
  }
  if (!REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    throw new InvalidRepoUrlError(`"${repo}" is not a valid GitHub repository name.`);
  }

  return { owner, repo, fullName: `${owner}/${repo}` };
}
