import { cookies } from "next/headers";
import { DEMO_COOKIE_NAME, verifyDemoToken } from "@/lib/auth/demo-jwt";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: string;
};

/**
 * Extracts and verifies the authenticated user from the request cookies.
 * Returns null if the user is not authenticated.
 */
export async function getAuthUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(DEMO_COOKIE_NAME)?.value;
  const claims = verifyDemoToken(token);

  if (!claims) {
    return null;
  }

  return {
    id: claims.sub,
    email: claims.email,
    name: claims.name,
    role: claims.role,
  };
}
