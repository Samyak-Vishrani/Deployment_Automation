import { createHash, timingSafeEqual } from "node:crypto";

export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/**
 * Constant-time check of the shared secret the main backend sends.
 *
 * Both sides are hashed first so the comparison is fixed-length: comparing raw
 * strings of different lengths would leak the expected length, and
 * timingSafeEqual throws on a length mismatch anyway.
 */
export function isValidInternalToken(expected: string, received: string | string[] | undefined): boolean {
  if (typeof received !== "string" || received.length === 0) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(received).digest();
  return timingSafeEqual(a, b);
}
