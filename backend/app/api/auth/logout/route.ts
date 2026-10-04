import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, sessionCookie, verifySessionToken } from "@/lib/auth/session";
import { clearGithubTokens } from "@/lib/auth/users";

export const runtime = "nodejs";

/**
 * Ends the session and forgets the user's stored GitHub tokens, so they do not
 * outlive it. The next sign-in stores a fresh pair.
 */
export async function POST() {
  const cookieStore = await cookies();
  const claims = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  if (claims) {
    // A database hiccup must not leave the user unable to sign out; the cookie
    // is cleared regardless.
    await clearGithubTokens({ userId: claims.sub }).catch((error: Error) =>
      console.error(`[auth] Could not clear GitHub tokens on sign-out: ${error.message}`),
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie("", 0));
  return response;
}
