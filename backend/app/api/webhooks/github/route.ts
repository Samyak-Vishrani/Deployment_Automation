import { NextResponse } from "next/server";
import { clearGithubTokens } from "@/lib/auth/users";
import type { PushPayload } from "@/lib/deployments/push-payload";
import { ensureBootstrapped, services } from "@/lib/runtime";
import { verifySignature } from "@/lib/webhooks/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The GitHub App's single webhook endpoint. Every installed repository delivers
 * here; which project (if any) a push belongs to is decided by the lookup in
 * DeploymentsService, not by the URL.
 *
 * Unauthenticated by design: GitHub cannot present a session cookie. The HMAC
 * over the raw body *is* the authentication, which is why nothing below the
 * signature check runs before it passes.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const rt = services();

  // request.text() gives the exact bytes GitHub sent. Parsing first and
  // re-serialising would change key order and whitespace, and the HMAC would
  // never match. This is the Next.js equivalent of Nest's rawBody: true.
  const raw = await request.text();
  if (!raw) {
    return NextResponse.json({ message: "Empty request body." }, { status: 400 });
  }
  const rawBody = Buffer.from(raw, "utf8");

  const signature = request.headers.get("x-hub-signature-256");
  const event = request.headers.get("x-github-event") ?? undefined;
  const deliveryId = request.headers.get("x-github-delivery") ?? undefined;

  let secret: string;
  try {
    secret = rt.github.getConfig().webhookSecret;
  } catch (error) {
    // A missing GITHUB_WEBHOOK_SECRET is a server misconfiguration, not a bad
    // delivery; answering 401 here would send the operator hunting the wrong
    // problem in GitHub's delivery log.
    console.error(`[webhook] GitHub App is not configured: ${(error as Error).message}`);
    return NextResponse.json(
      { message: "The GitHub App is not configured on this server." },
      { status: 500 },
    );
  }

  // Verify BEFORE parsing: the body is untrusted until the HMAC says otherwise,
  // and the HMAC must be over the exact bytes received.
  if (!verifySignature(secret, rawBody, signature)) {
    console.warn(
      `[webhook] Rejected delivery ${deliveryId ?? "unknown"}: invalid X-Hub-Signature-256.`,
    );
    return NextResponse.json({ message: "Invalid webhook signature." }, { status: 401 });
  }

  // GitHub retries deliveries; the delivery ID makes them safe to ignore.
  if (deliveryId && !rt.deliveries.markAsProcessed(deliveryId)) {
    console.log(`[webhook] Duplicate delivery ${deliveryId} ignored.`);
    return NextResponse.json({ received: true, status: "duplicate" });
  }

  if (event === "ping") {
    console.log("[webhook] Ping received from GitHub - the webhook is wired up correctly.");
    return NextResponse.json({ received: true, status: "pong" });
  }

  // GitHub sends these three to every App, with no subscription needed.
  if (
    event === "installation" ||
    event === "installation_repositories" ||
    event === "github_app_authorization"
  ) {
    let payload: { action?: string; sender?: { id?: number } };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return NextResponse.json({ message: "Webhook body is not valid JSON." }, { status: 400 });
    }
    const action = payload.action ?? "unknown";

    if (event === "github_app_authorization") {
      // The user revoked the App under Settings -> Applications. Their stored
      // token is dead; keeping it would only make the next call fail.
      if (action === "revoked" && payload.sender?.id !== undefined) {
        const cleared = await clearGithubTokens({ githubUserId: String(payload.sender.id) });
        console.log(`[webhook] Authorization revoked; cleared tokens on ${cleared} connection(s).`);
      }
      return NextResponse.json({ received: true, status: "processed" });
    }

    // Identifiers only, as with every app event: an open repository picker
    // refetches, with its own user's token, rather than trusting this payload.
    rt.events.emit({ kind: "github", action: `${event}.${action}` });
    console.log(`[webhook] ${event}.${action}; repository lists notified.`);
    return NextResponse.json({ received: true, status: "processed" });
  }

  if (event !== "push") {
    console.log(`[webhook] Ignoring "${event ?? "unknown"}" event.`);
    return NextResponse.json({ received: true, status: "ignored" });
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(raw) as PushPayload;
  } catch {
    return NextResponse.json({ message: "Webhook body is not valid JSON." }, { status: 400 });
  }

  // The queue has to be restored before a job is added to it, or a push
  // arriving as the first request after a restart would be enqueued into a
  // queue with no runner attached and sit there.
  await ensureBootstrapped();

  // Hand off WITHOUT awaiting. GitHub allows about ten seconds, and a build
  // takes minutes, so the work must leave the request path here.
  //
  // The .catch is mandatory, not stylistic: Node's default
  // --unhandled-rejections=throw would take the whole backend down the first
  // time a malformed payload made this reject.
  void rt.deployments
    .handlePush(payload, deliveryId)
    .catch((error: Error) =>
      console.error(`[webhook] Failed to handle delivery ${deliveryId}: ${error.message}`),
    );

  return NextResponse.json({ received: true, status: "accepted" });
}
