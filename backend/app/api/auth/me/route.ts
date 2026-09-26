import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { findPublicUser } from "@/lib/auth/users";

export const runtime = "nodejs";

export async function GET() {
  const cookieStore = await cookies();
  const claims = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  const user = claims ? await findPublicUser(claims.sub) : null;

  if (!user) {
    return NextResponse.json({ message: "Authentication required." }, { status: 401 });
  }

  return NextResponse.json({ user });
}
