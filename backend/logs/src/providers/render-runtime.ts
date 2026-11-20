import type { RuntimeLogLine } from "@orbitops/integration-common/contract";
import { stripAnsi } from "../entries/ansi";

/**
 * One entry of Render's `GET /v1/logs`: `{ id, message, timestamp, labels }`,
 * labels including `type` (app | request | build), `level`, `instance`,
 * `method`, `path`, `statusCode` (Render's API reference, 2026-11-04).
 */
export interface RenderLogEntry {
  id?: string;
  message?: string;
  timestamp?: string;
  labels?: Array<{ name?: string; value?: string }>;
}

export interface RenderLogPage {
  logs?: RenderLogEntry[];
  hasMore?: boolean;
  nextStartTime?: string;
  nextEndTime?: string;
}

const label = (entry: RenderLogEntry, name: string) => entry.labels?.find((l) => l.name === name)?.value;

/** An app line (or, with `includeRequests`, an HTTP request line); build output and blanks are dropped. */
export function toRenderRuntimeLine(entry: RenderLogEntry, options: { includeRequests: boolean }): RuntimeLogLine | null {
  if (!entry || typeof entry.message !== "string") return null;
  const type = label(entry, "type");
  if (type === "build") return null;
  if (type === "request" && !options.includeRequests) return null;

  const text = stripAnsi(entry.message).replace(/\r?\n$/, "");
  if (text.trim() === "") return null;
  const at = Date.parse(entry.timestamp ?? "");
  const level = label(entry, "level")?.toLowerCase();
  const status = Number(label(entry, "statusCode"));
  const request =
    type === "request"
      ? {
          ...(label(entry, "method") ? { method: label(entry, "method") } : {}),
          ...(label(entry, "path") ? { path: label(entry, "path") } : {}),
          ...(Number.isFinite(status) && label(entry, "statusCode") ? { status } : {}),
        }
      : undefined;

  return {
    id: entry.id ?? `${entry.timestamp}:${text.slice(0, 80)}`,
    at: Number.isFinite(at) ? at : Date.now(),
    stream: level === "error" || level === "fatal" || (request?.status ?? 0) >= 500 ? "stderr" : "stdout",
    ...(level ? { level } : {}),
    text,
    ...(request ? { request } : {}),
  };
}

export function toRenderRuntimeLines(page: unknown, options: { includeRequests: boolean }): RuntimeLogLine[] {
  const logs = (page as RenderLogPage | null)?.logs;
  if (!Array.isArray(logs)) return [];
  return logs.flatMap((entry) => {
    const line = entry && typeof entry === "object" ? toRenderRuntimeLine(entry, options) : null;
    return line ? [line] : [];
  });
}
