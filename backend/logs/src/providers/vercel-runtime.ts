import type { RuntimeLogLine } from "@orbitops/integration-common/contract";
import { stripAnsi } from "../entries/ansi";

/**
 * One line of `GET /v1/projects/:projectId/deployments/:deploymentId/runtime-logs`
 * (`application/stream+json`, one object per line; Vercel's docs, 2026-11-04).
 * The docs' example sends numbers as strings, so both are read.
 */
export interface VercelRuntimeRow {
  rowId?: string;
  timestampInMs?: number | string;
  level?: string;
  message?: string;
  messageTruncated?: boolean | string;
  requestMethod?: string;
  requestPath?: string;
  responseStatusCode?: number | string;
  source?: string;
  domain?: string;
}

const ERROR_LEVELS = new Set(["error", "fatal"]);

/** A runtime line, or null for rows that carry no output (Vercel's "delimiter" rows). */
export function toVercelRuntimeLine(raw: unknown): RuntimeLogLine | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as VercelRuntimeRow;
  if (row.source === "delimiter") return null;

  const at = Number(row.timestampInMs);
  const status = row.responseStatusCode === undefined || row.responseStatusCode === "" ? undefined : Number(row.responseStatusCode);
  const request =
    row.requestPath || row.requestMethod
      ? {
          ...(row.requestMethod ? { method: row.requestMethod } : {}),
          ...(row.requestPath ? { path: row.requestPath } : {}),
          ...(status !== undefined && Number.isFinite(status) ? { status } : {}),
        }
      : undefined;

  let text = typeof row.message === "string" ? stripAnsi(row.message).replace(/\r?\n$/, "") : "";
  if (!text && request) text = [request.method, request.path, request.status].filter(Boolean).join(" ");
  if (!text) return null;
  if (row.messageTruncated === true || row.messageTruncated === "true") text += " …(truncated by Vercel)";

  const level = typeof row.level === "string" ? row.level.toLowerCase() : undefined;
  return {
    id: row.rowId ?? `${row.timestampInMs}:${text.slice(0, 80)}`,
    at: Number.isFinite(at) ? at : Date.now(),
    stream: level && ERROR_LEVELS.has(level) ? "stderr" : "stdout",
    ...(level ? { level } : {}),
    text,
    ...(request ? { request } : {}),
  };
}
