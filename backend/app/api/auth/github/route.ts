import { NextResponse, type NextRequest } from "next/server";
import {
  buildAuthorizeUrl,
  createOAuthState,
  encodeOAuthState,
  frontendUrl,
  loadGithubOAuthConfig,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  safeNextPath,
} from "@/lib/auth/github-oauth";

export const runtime = "nodejs";

/**
 * Step 1 of GitHub sign-in: send the browser to GitHub's consent screen.
 *
 * `?next=/path` is where to land afterwards; `?switch=1` forces GitHub's
 * account picker so a different GitHub account can be chosen.
 */
export async function GET(request: NextRequest) {
  let config;
  try {
    config = loadGithubOAuthConfig();
  } catch (error) {
    console.error("[auth]", error instanceof Error ? error.message : error);
    return NextResponse.redirect(`${frontendUrl()}/login?error=not_configured`);
  }

  const params = request.nextUrl.searchParams;
  const oauth = createOAuthState(safeNextPath(params.get("next")));
  const response = NextResponse.redirect(
    buildAuthorizeUrl(config, oauth, { selectAccount: params.get("switch") === "1" }),
  );

  // Binds the callback to this browser: a code GitHub hands back to anyone else
  // arrives without the matching cookie and is refused (login CSRF).
  response.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: encodeOAuthState(oauth),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth/github",
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
  return response;
}
