/**
 * The GitHub REST plumbing shared by the App-authenticated service
 * (github-app.service) and the user-authenticated one (github-user.service).
 * The caller supplies the Authorization header; nothing here knows or logs it.
 */

export const GITHUB_API = "https://api.github.com";

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

export interface GithubApiResponse<T> {
  status: number;
  body: T;
}

export async function request<T>(
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
export function describe(response: GithubApiResponse<unknown>): string {
  const message = (response.body as { message?: string } | null)?.message ?? "";
  return `HTTP ${response.status}${message ? ` - ${message}` : ""}`;
}
