import type { NormalisedStatus } from "../types";

/**
 * Render's deploy `status` → our provider-neutral status.
 *
 * `deactivated` means the deploy went live and was later replaced by a newer
 * one: for the deploy we are tracking, that is a success.
 */
export function normaliseDeployStatus(status: string | null | undefined): NormalisedStatus {
  switch ((status ?? "").toLowerCase()) {
    case "created":
    case "queued":
      return "queued";
    case "build_in_progress":
    case "pre_deploy_in_progress":
      return "building";
    case "update_in_progress":
      return "deploying";
    case "live":
    case "deactivated":
      return "live";
    case "build_failed":
    case "update_failed":
    case "pre_deploy_failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      // Unknown or missing: not terminal, keep polling.
      return "building";
  }
}
