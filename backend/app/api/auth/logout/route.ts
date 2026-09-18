import { NextResponse } from "next/server";
import { DEMO_COOKIE_NAME } from "@/lib/auth/demo-jwt";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: DEMO_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
