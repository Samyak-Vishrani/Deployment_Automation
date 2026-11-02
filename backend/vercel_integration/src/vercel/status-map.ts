import type { NormalisedStatus } from "../types";

/**
 * Vercel's `readyState` → our provider-neutral status.
 *
 * QUEUED is reported as "queued", but the main backend still shows the
 * Deployment as running: the job is ours and in flight, Vercel is just busy.
 */
export function normaliseReadyState(readyState: string | null | undefined): NormalisedStatus {
  switch ((readyState ?? "").toUpperCase()) {
    case "QUEUED":
      return "queued";
    case "INITIALIZING":
    case "BUILDING":
      return "building";
    case "READY":
      return "live";
    case "ERROR":
      return "failed";
    case "CANCELED":
    case "CANCELLED":
      return "cancelled";
    default:
      // An unknown or missing state is not terminal: keep polling.
      return "building";
  }
}
