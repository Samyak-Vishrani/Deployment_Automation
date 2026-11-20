import { createHmac } from "node:crypto";
import type { EventBatch } from "./contract";

export const SIGNATURE_HEADER = "x-orbitops-signature";
/**
 * Tells the backend which integration sent the batch, so it verifies the HMAC
 * with that integration's own secret (INTERNAL_CALLBACK_SECRET for Vercel,
 * RENDER_CALLBACK_SECRET for Render) and checks the deployment really belongs
 * to that provider. A batch without it is treated as Vercel's.
 */
export const PROVIDER_HEADER = "x-orbitops-provider";
export const CALLBACK_PATH = "/api/internal/provider-events";

/** `sha256=<hex HMAC of the raw body>`, the same scheme GitHub webhooks use. */
export function signBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export type DeliveryResult =
  /** The main backend applied it (or had already). */
  | "delivered"
  /** It will never be accepted (the deployment no longer exists): stop retrying. */
  | "rejected"
  /** Try again later. */
  | "retry";

export interface CallbackSender {
  send(batch: EventBatch): Promise<DeliveryResult>;
}

/** POSTs signed event batches to the main backend. */
export class CallbackClient implements CallbackSender {
  constructor(
    private readonly mainApiUrl: string,
    private readonly secret: string,
    /** "vercel", "render": sent in x-orbitops-provider. */
    private readonly provider: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(batch: EventBatch): Promise<DeliveryResult> {
    const rawBody = JSON.stringify(batch);
    let response: Response;
    try {
      response = await fetch(`${this.mainApiUrl}${CALLBACK_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signBody(this.secret, rawBody),
          [PROVIDER_HEADER]: this.provider,
        },
        body: rawBody,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return "retry"; // main backend down or restarting
    }
    await response.arrayBuffer().catch(() => undefined);

    if (response.ok) return "delivered";
    // 404: the deployment (or its project) was deleted. 400: a contract
    // mismatch that retrying cannot fix. Everything else - 401 from a secret
    // being rotated, 5xx - may heal, so it is retried.
    if (response.status === 404 || response.status === 400 || response.status === 410) return "rejected";
    return "retry";
  }
}
