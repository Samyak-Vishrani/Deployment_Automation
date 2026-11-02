import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { parseEventBatch } from "@/lib/providers/event-batch-input";
import { services } from "@/lib/runtime";
import { verifySignature } from "@/lib/webhooks/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Each integration service signs with its own secret, named by the
 * x-orbitops-provider header it sends. No header means the Vercel service,
 * which predates the header.
 */
const CALLBACK_SECRETS: Record<string, string> = {
  vercel: "INTERNAL_CALLBACK_SECRET",
  render: "RENDER_CALLBACK_SECRET",
};

/**
 * Deploy events from the provider integration services (vercel_integration,
 * render_integration): status changes, the provider resource and deployment
 * ids, build log lines, and the terminal state.
 *
 * Not a user route, so no session. The body is authenticated instead with an
 * HMAC over the raw bytes, exactly as GitHub webhooks are, using the sending
 * service's own secret. A service may only report on its own provider's
 * deployments (403 otherwise), so one leaked secret cannot rewrite another
 * provider's deploys. Batches carry a sequence number and are applied at most
 * once, so a service can safely redeliver.
 *
 * 404 for an unknown deployment tells the service to stop retrying it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const provider = (request.headers.get("x-orbitops-provider") ?? "vercel").trim().toLowerCase();
  const secretVar = CALLBACK_SECRETS[provider];
  if (!secretVar) {
    return NextResponse.json({ error: "unauthorized", message: "Unknown provider." }, { status: 401 });
  }
  const secret = process.env[secretVar]?.trim();
  if (!secret) {
    console.error(`[provider-events] ${secretVar} is not set; rejecting ${provider} callbacks.`);
    return NextResponse.json(
      { error: "not_configured", message: `${secretVar} is not set on the backend.` },
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
    const result = await services().providerDeployments.applyBatch(batch, provider as "vercel" | "render");
    return NextResponse.json({ received: true, ...result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
