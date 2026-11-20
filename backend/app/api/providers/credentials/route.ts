import { NextResponse } from "next/server";
import { HttpError, toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every provider account the user can connect, and its state. Never a token.
 *
 * Vercel's, Render's and Neon's states come from their integration services. When a
 * service is down its row says "unavailable" instead of failing the whole
 * list, so the Settings page still renders.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const rt = services();

    const lookup = async (provider: "vercel" | "render" | "neon"): Promise<Record<string, unknown>> => {
      try {
        return { ...(await rt[provider].getCredential(user.id)) };
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return { provider, state: "unavailable", message: error.message };
      }
    };

    const [vercel, render, neon] = await Promise.all([lookup("vercel"), lookup("render"), lookup("neon")]);
    return NextResponse.json([vercel, render, neon]);
  } catch (error) {
    return toErrorResponse(error);
  }
}
