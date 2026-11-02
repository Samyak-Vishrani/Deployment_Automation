import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { parseEventBatch } from "@/lib/providers/event-batch-input";
import { services } from "@/lib/runtime";
import { verifySignature } from "@/lib/webhooks/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deploy events from the vercel_integration service: status changes, the
 * Vercel project and deployment ids, build log lines, and the terminal state.
 *
 * Not a user route, so no session. The body is authenticated instead with an
 * HMAC over the raw bytes (INTERNAL_CALLBACK_SECRET, shared with the service),
 * exactly as GitHub webhooks are. Batches carry a sequence number and are
 * applied at most once, so the service can safely redeliver.
 *
 * 404 for an unknown deployment tells the service to stop retrying it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.INTERNAL_CALLBACK_SECRET?.trim();
  if (!secret) {
    console.error("[provider-events] INTERNAL_CALLBACK_SECRET is not set; rejecting callbacks.");
    return NextResponse.json(
      { error: "not_configured", message: "INTERNAL_CALLBACK_SECRET is not set on the backend." },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  if (!verifySignature(secret, Buffer.from(rawBody, "utf8"), request.headers.get("x-orbitops-signature"))) {
    return NextResponse.json({ error: "unauthorized", message: "Bad signature." }, { status: 401 });
  }

  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = null;
    }
    const batch = parseEventBatch(parsed);
    const result = await services().providerDeployments.applyBatch(batch);
    return NextResponse.json({ received: true, ...result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
