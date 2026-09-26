import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the X-Hub-Signature-256 header GitHub sends with every delivery.
 * The HMAC must be computed over the exact raw request body.
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = Buffer.from(
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"),
    "utf8",
  );
  const received = Buffer.from(signatureHeader, "utf8");

  // timingSafeEqual throws on length mismatch, so compare lengths first.
  return expected.length === received.length && timingSafeEqual(expected, received);
}
