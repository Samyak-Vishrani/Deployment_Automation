import { createHash, randomBytes } from "node:crypto";

/**
 * GitHub OAuth 2.0 (authorization code + PKCE) for signing users in.
 *
 * This is separate from the GitHub App in lib/github: the App acts on
 * repositories as an installation, while this flow only answers "which GitHub
 * user is this?". It asks for the minimum scopes that answer it and never
 * keeps the user's access token - nothing needs it after the callback.
 *
 * Either a classic OAuth App or the GitHub App's own client id/secret work
 * here; both speak the same /login/oauth endpoints.
 */

export const OAUTH_STATE_COOKIE = "orbitops_oauth_state";
export const OAUTH_STATE_TTL_SECONDS = 60 * 10;

const SCOPES = "read:user user:email";

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export class OAuthConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `GitHub login is not configured. Missing: ${missing.join(", ")}. ` +
        "Create a GitHub OAuth App and add its values to backend/.env.",
    );
    this.name = "OAuthConfigError";
  }
}

export function loadGithubOAuthConfig(env: NodeJS.ProcessEnv = process.env): GithubOAuthConfig {
  const missing = ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new OAuthConfigError(missing);
  }

  return {
    clientId: env.GITHUB_OAUTH_CLIENT_ID!.trim(),
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET!.trim(),
    callbackUrl:
      env.GITHUB_OAUTH_CALLBACK_URL?.trim() || "http://localhost:3001/api/auth/github/callback",
  };
}

export function frontendUrl(): string {
  return (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Only same-site relative paths survive. "//evil.com" and "/\evil.com" are
 * protocol-relative to a browser, so they are rejected along with absolute URLs;
 * otherwise the login flow becomes an open redirect.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/dashboard";
  }
  return value;
}

/** What the state cookie holds between the redirect out and the callback. */
export type OAuthState = {
  state: string;
  verifier: string;
  next: string;
};

export function createOAuthState(next: string): OAuthState {
  return {
    state: randomBytes(24).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    next,
  };
}

export function encodeOAuthState(value: OAuthState): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeOAuthState(raw: string | undefined): OAuthState | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as OAuthState;
    if (typeof value.state !== "string" || typeof value.verifier !== "string") {
      return null;
    }
    return { ...value, next: safeNextPath(value.next) };
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl(
  config: GithubOAuthConfig,
  oauth: OAuthState,
  options: { selectAccount?: boolean } = {},
): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", oauth.state);
  url.searchParams.set("allow_signup", "true");
  url.searchParams.set(
    "code_challenge",
    createHash("sha256").update(oauth.verifier).digest("base64url"),
  );
  url.searchParams.set("code_challenge_method", "S256");
  if (options.selectAccount) {
    // Shows GitHub's account picker even when a GitHub session already exists.
    // Without it, a user who signed out of OrbitOps is silently signed straight
    // back in as the same GitHub account.
    url.searchParams.set("prompt", "select_account");
  }
  return url.toString();
}

export type GithubProfile = {
  githubUserId: string;
  login: string;
  name: string;
  email: string;
  avatarUrl: string | null;
};

async function githubApi<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "orbitops",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} answered ${response.status}.`);
  }
  return (await response.json()) as T;
}

export async function exchangeCodeForToken(
  config: GithubOAuthConfig,
  code: string,
  verifier: string,
): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
      code_verifier: verifier,
    }),
    cache: "no-store",
  });

  // GitHub answers 200 even for a rejected code; the failure is in the body.
  const body = (await response.json().catch(() => null)) as
    | { access_token?: string; error?: string; error_description?: string }
    | null;
  if (!response.ok || !body?.access_token) {
    throw new Error(body?.error_description ?? body?.error ?? "GitHub did not return an access token.");
  }
  return body.access_token;
}

export async function fetchGithubProfile(token: string): Promise<GithubProfile> {
  const user = await githubApi<{
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  }>("/user", token);

  // The public profile email is optional and unverified; the emails endpoint
  // gives the verified primary address.
  const emails = await githubApi<Array<{ email: string; primary: boolean; verified: boolean }>>(
    "/user/emails",
    token,
  ).catch(() => []);
  const primary = emails.find((entry) => entry.primary && entry.verified)?.email;

  return {
    githubUserId: String(user.id),
    login: user.login,
    name: user.name?.trim() || user.login,
    // Users can hide every address; the noreply form is unique per account and
    // keeps User.email's unique constraint satisfied.
    email: (primary ?? `${user.id}+${user.login}@users.noreply.github.com`).toLowerCase(),
    avatarUrl: user.avatar_url,
  };
}
