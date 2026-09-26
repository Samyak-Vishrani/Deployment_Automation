import { NextResponse } from "next/server";
import { createDemoToken, DEMO_COOKIE_NAME } from "@/lib/auth/xxx_demo-jwt";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { email?: string; password?: string }
    | null;

  if (body?.email !== "demo@orbitops.dev" || body.password !== "orbitops") {
    return NextResponse.json(
      { message: "Use demo@orbitops.dev and orbitops to enter the local demo." },
      { status: 401 },
    );
  }

  const response = NextResponse.json({
    user: {
      id: "user_demo_01",
      name: "Aarav Shah",
      email: "demo@orbitops.dev",
      role: "platform-admin",
      avatarInitials: "AS",
    },
  });

  response.cookies.set({
    name: DEMO_COOKIE_NAME,
    value: createDemoToken(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });

  return response;
}
