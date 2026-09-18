import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const allowedMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const allowedHeaders = "Content-Type, Authorization";
const defaultOrigin = process.env.FRONTEND_URL ?? "http://localhost:3000";

export function middleware(request: NextRequest) {
  const requestOrigin = request.headers.get("origin") ?? defaultOrigin;
  const isAllowedOrigin = requestOrigin === defaultOrigin || requestOrigin === "http://localhost:3000";
  const response = NextResponse.next();

  response.headers.set("Access-Control-Allow-Origin", isAllowedOrigin ? requestOrigin : defaultOrigin);
  response.headers.set("Access-Control-Allow-Methods", allowedMethods);
  response.headers.set("Access-Control-Allow-Headers", allowedHeaders);
  response.headers.set("Access-Control-Allow-Credentials", "true");

  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": isAllowedOrigin ? requestOrigin : defaultOrigin,
        "Access-Control-Allow-Methods": allowedMethods,
        "Access-Control-Allow-Headers": allowedHeaders,
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }

  return response;
}

export const config = {
  matcher: "/:path*",
};
