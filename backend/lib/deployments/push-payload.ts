/**
 * The slice of GitHub's push payload this app reads.
 *
 * Everything is optional: the payload is attacker-shaped input as far as the
 * type system is concerned, and a missing field must produce "skip", never a
 * TypeError inside the webhook handler.
 *
 * @link https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
 */
export interface PushCommit {
  id?: string;
  message?: string;
  added?: string[];
  modified?: string[];
  removed?: string[];
  author?: { username?: string; name?: string };
}

export interface PushPayload {
  /** "refs/heads/main" for a branch, "refs/tags/v1" for a tag. */
  ref?: string;
  /** Head sha after the push. All zeroes when a branch was deleted. */
  after?: string;
  before?: string;
  /** True when the push deleted the ref. */
  deleted?: boolean;
  created?: boolean;
  forced?: boolean;
  repository?: {
    /** Numeric id. The routing key - survives renames and transfers. */
    id?: number;
    full_name?: string;
    name?: string;
    owner?: { name?: string; login?: string };
    default_branch?: string;
  };
  /** Truncated to 20 entries by GitHub. See shouldDeploy. */
  commits?: PushCommit[];
  head_commit?: PushCommit | null;
  pusher?: { name?: string };
  sender?: { login?: string };
}

/** A branch delete arrives as a push whose `after` is all zeroes. */
export const ZERO_SHA = '0000000000000000000000000000000000000000';
