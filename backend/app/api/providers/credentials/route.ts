import { NextResponse } from "next/server";
import { HttpError, toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every provider account the user can connect, and its state. Never a token.
 *
 * Vercel's and Render's states come from their integration services. When a
 * service is down its row says "unavailable" instead of failing the whole
 * list, so the Settings page still renders.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const rt = services();

    const lookup = async (provider: "vercel" | "render"): Promise<Record<string, unknown>> => {
      try {
        return { ...(await rt[provider].getCredential(user.id)) };
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return { provider, state: "unavailable", message: error.message };
      }
    };

    const [vercel, render] = await Promise.all([lookup("vercel"), lookup("render")]);
    return NextResponse.json([
      vercel,
      render,
      { provider: "neon", state: "unavailable", message: "Provisioning on Neon arrives in Phase 8." },
    ]);
  } catch (error) {
    return toErrorResponse(error);
  }
}
