import { createHmac } from "node:crypto";
import type { EventBatch } from "../types";

export const SIGNATURE_HEADER = "x-orbitops-signature";
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
    private readonly timeoutMs = 10_000,
  ) {}

  async send(batch: EventBatch): Promise<DeliveryResult> {
    const rawBody = JSON.stringify(batch);
    let response: Response;
    try {
      response = await fetch(`${this.mainApiUrl}${CALLBACK_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(this.secret, rawBody) },
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
