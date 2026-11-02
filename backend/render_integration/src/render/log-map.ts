import type { LogLine } from "../types";

/**
 * One entry of `GET /v1/logs`: `{ id, message, timestamp, labels: [{ name, value }] }`.
 * Labels include `type` (build | app | request) and `level`. Run `npm run spike`
 * to see the labels Render currently sends.
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

function label(entry: RenderLogEntry, name: string): string | undefined {
  return entry.labels?.find((l) => l.name === name)?.value;
}

/** Build and app output we show. HTTP request logs of the running service are dropped. */
export function toLogLine(entry: RenderLogEntry): LogLine | null {
  if (typeof entry.message !== "string") return null;
  const type = label(entry, "type");
  if (type === "request") return null;

  const text = entry.message.replace(/\r?\n$/, "");
  if (text.trim() === "") return null;

  const at = Date.parse(entry.timestamp ?? "");
  const level = (label(entry, "level") ?? "").toLowerCase();
  const stream: LogLine["stream"] = level === "error" || level === "fatal" ? "stderr" : "stdout";
  return {
    id: entry.id ?? `${entry.timestamp}:${text}`,
    at: Number.isFinite(at) ? at : 0,
    stream,
    text,
  };
}

export function toLogLines(page: unknown): LogLine[] {
  const logs = (page as RenderLogPage | null)?.logs;
  if (!Array.isArray(logs)) return [];
  const lines: LogLine[] = [];
  for (const entry of logs) {
    if (entry && typeof entry === "object") {
      const line = toLogLine(entry);
      if (line) lines.push(line);
    }
  }
  return lines;
}
