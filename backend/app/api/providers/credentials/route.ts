import { NextResponse } from "next/server";
import { HttpError, toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every provider account the user can connect, and its state. Never a token.
 *
 * Vercel's state comes from the vercel_integration service; when that service
 * is down its row says "unavailable" instead of failing the whole list, so the
 * Settings page still renders.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    let vercel: Record<string, unknown>;
    try {
      vercel = { ...(await services().vercel.getCredential(user.id)) };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      vercel = { provider: "vercel", state: "unavailable", message: error.message };
    }
    return NextResponse.json([
      vercel,
      { provider: "render", state: "unavailable", message: "Deploying to Render arrives in Phase 7." },
      { provider: "neon", state: "unavailable", message: "Provisioning on Neon arrives in Phase 8." },
    ]);
  } catch (error) {
    return toErrorResponse(error);
  }
}
