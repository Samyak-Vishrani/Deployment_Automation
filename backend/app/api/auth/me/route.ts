import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DEMO_COOKIE_NAME, verifyDemoToken } from "@/lib/auth/demo-jwt";

export const runtime = "nodejs";

export async function GET() {
  const cookieStore = await cookies();
  const claims = verifyDemoToken(cookieStore.get(DEMO_COOKIE_NAME)?.value);

  if (!claims) {
    return NextResponse.json({ message: "Authentication required." }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      id: claims.sub,
      name: claims.name,
      email: claims.email,
      role: claims.role,
      avatarInitials: claims.name
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2),
    },
  });
}
