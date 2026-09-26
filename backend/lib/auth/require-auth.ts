import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { findPublicUser } from "@/lib/auth/users";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: string;
};

/**
 * Extracts and verifies the authenticated user from the request cookies.
 * Returns null if the user is not authenticated, or if the account the token
 * names no longer exists.
 */
export async function getAuthUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const claims = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  if (!claims) {
    return null;
  }

  const user = await findPublicUser(claims.sub);
  if (!user) {
    return null;
  }

  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
