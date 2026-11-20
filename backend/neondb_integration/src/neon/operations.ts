/**
 * Neon runs every change (creating a project, starting its compute) as an
 * "operation". A project is usable once none of its operations is still
 * scheduled or running. Statuses seen in Neon's API reference:
 * scheduling, running, finished, failed, error, cancelling, cancelled, skipped.
 * (Step 0's spike records the ones a real project goes through.)
 */

export interface NeonOperation {
  id?: string;
  action?: string;
  status?: string;
  error?: string;
  failures_count?: number;
}

const IN_PROGRESS = new Set(["scheduling", "running", "cancelling"]);
const FAILED = new Set(["failed", "error"]);

/** Every operation has stopped (finished, failed, cancelled or skipped). */
export function allFinished(operations: NeonOperation[]): boolean {
  return operations.every((op) => !IN_PROGRESS.has(String(op.status ?? "").toLowerCase()));
}

/** The first operation that failed, if any. */
export function firstFailure(operations: NeonOperation[]): NeonOperation | undefined {
  return operations.find((op) => FAILED.has(String(op.status ?? "").toLowerCase()));
}

/** "start_compute failed: <error>" for a user-facing message. */
export function describeFailure(op: NeonOperation): string {
  const action = op.action ? op.action.replace(/_/g, " ") : "an operation";
  return op.error ? `${action} failed: ${op.error}` : `${action} failed`;
}

export function asOperations(value: unknown): NeonOperation[] {
  return Array.isArray(value) ? value.filter((op): op is NeonOperation => !!op && typeof op === "object") : [];
}
