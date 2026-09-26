import { NextResponse, type NextRequest } from "next/server";
import {
  decodeOAuthState,
  exchangeCodeForToken,
  fetchGithubProfile,
  frontendUrl,
  loadGithubOAuthConfig,
  OAUTH_STATE_COOKIE,
} from "@/lib/auth/github-oauth";
import { createSessionToken, sessionCookie, SESSION_TTL_SECONDS } from "@/lib/auth/session";
import { upsertGithubUser } from "@/lib/auth/users";

export const runtime = "nodejs";

function fail(code: string) {
  const response = NextResponse.redirect(`${frontendUrl()}/login?error=${code}`);
  response.cookies.set({ name: OAUTH_STATE_COOKIE, value: "", path: "/api/auth/github", maxAge: 0 });
  return response;
}

/**
 * Step 2 of GitHub sign-in: GitHub redirects back here with ?code&state.
 * Verifies the state, trades the code for a token, reads the profile, and
 * issues our own session cookie. The GitHub token is dropped afterwards.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // The user pressed "Cancel" on GitHub's consent screen.
  if (params.get("error") === "access_denied") {
    return fail("access_denied");
  }

  const code = params.get("code");
  const state = params.get("state");
  const saved = decodeOAuthState(request.cookies.get(OAUTH_STATE_COOKIE)?.value);
  if (!code || !state || !saved || saved.state !== state) {
    return fail("invalid_state");
  }

  let userId: string;
  try {
    const config = loadGithubOAuthConfig();
    const token = await exchangeCodeForToken(config, code, saved.verifier);
    const profile = await fetchGithubProfile(token);
    userId = await upsertGithubUser(profile);
  } catch (error) {
    console.error("[auth] GitHub sign-in failed:", error instanceof Error ? error.message : error);
    return fail("github_failed");
  }

  const response = NextResponse.redirect(`${frontendUrl()}${saved.next}`);
  response.cookies.set(sessionCookie(createSessionToken(userId), SESSION_TTL_SECONDS));
  response.cookies.set({ name: OAUTH_STATE_COOKIE, value: "", path: "/api/auth/github", maxAge: 0 });
  return response;
}
