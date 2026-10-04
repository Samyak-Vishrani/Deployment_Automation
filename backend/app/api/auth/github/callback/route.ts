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

/** Where a user lands after installing the App: the repository picker. */
const INSTALL_LANDING = "/deploy/new";

function fail(code: string) {
  const response = NextResponse.redirect(`${frontendUrl()}/login?error=${code}`);
  response.cookies.set({ name: OAUTH_STATE_COOKIE, value: "", path: "/api/auth/github", maxAge: 0 });
  return response;
}

/**
 * Step 2 of GitHub sign-in: GitHub redirects back here with ?code&state.
 * Verifies the state, trades the code for the user's token pair, reads the
 * profile, stores the pair sealed, and issues our own session cookie.
 *
 * GitHub also sends the browser here after an App install or a change to an
 * installation's repositories (?installation_id&setup_action, plus a code).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const saved = decodeOAuthState(request.cookies.get(OAUTH_STATE_COOKIE)?.value);
  const stateMatches = Boolean(state && saved && saved.state === state);

  // An install redirect carries no state of ours, and GitHub documents its
  // installation_id as spoofable, so its code is never exchanged - a link
  // crafted by someone else must not be able to sign this browser in. Restart
  // sign-in instead: the App is already authorised, so GitHub answers without
  // a second prompt, and the fresh token sees the new installation.
  if (params.has("setup_action") && !stateMatches) {
    const restart = request.nextUrl.clone();
    restart.pathname = "/api/auth/github";
    restart.search = `?next=${encodeURIComponent(INSTALL_LANDING)}`;
    return NextResponse.redirect(restart);
  }

  // The user pressed "Cancel" on GitHub's consent screen.
  if (params.get("error") === "access_denied") {
    return fail("access_denied");
  }

  if (!code || !saved || !stateMatches) {
    return fail("invalid_state");
  }

  let userId: string;
  try {
    const config = loadGithubOAuthConfig();
    const tokens = await exchangeCodeForToken(config, code, saved.verifier);
    const profile = await fetchGithubProfile(tokens.accessToken);
    userId = await upsertGithubUser(profile, tokens);
  } catch (error) {
    console.error("[auth] GitHub sign-in failed:", error instanceof Error ? error.message : error);
    return fail("github_failed");
  }

  const response = NextResponse.redirect(`${frontendUrl()}${saved.next}`);
  response.cookies.set(sessionCookie(createSessionToken(userId), SESSION_TTL_SECONDS));
  response.cookies.set({ name: OAUTH_STATE_COOKIE, value: "", path: "/api/auth/github", maxAge: 0 });
  return response;
}
