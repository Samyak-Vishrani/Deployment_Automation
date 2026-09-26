import { unauthorized } from "@/lib/api/http-error";
import { getAuthUser, type AuthUser } from "@/lib/auth/require-auth";

/**
 * The authenticated user, as a row that actually exists in the database.
 *
 * Users are created by the GitHub sign-in callback, and getAuthUser() already
 * looks the session's user id up in Postgres, so a user returned here is always
 * safe to use as Project.userId.
 */
export async function requireUser(): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!user) {
    throw unauthorized();
  }
  return user;
}
