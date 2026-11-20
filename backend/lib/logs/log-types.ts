/**
 * The log shapes the main backend shares with backend/logs (Phase 12). The
 * logs service's copy lives in backend/integration_common/src/contract.ts;
 * change both together.
 */

/** Who wrote a stored build-log line. */
export type LogSource = "orbitops" | "vercel" | "render" | "neon" | "docker";
/** Where in a deploy it was written. */
export type LogPhase = "setup" | "build" | "deploy" | "runtime";
export type LogStream = "info" | "stdout" | "stderr";

/** A stored build-log line; `seq` is assigned by the logs service. */
export interface LogEntry {
  seq: number;
  at: number;
  source: LogSource;
  phase: LogPhase;
  stream: LogStream;
  text: string;
}

/** Optional tags for one written line; the writer fills in the rest. */
export interface WriteMeta {
  source?: LogSource;
  phase?: LogPhase;
  stream?: LogStream;
  at?: number;
}

export interface LogsReadResult {
  entries: LogEntry[];
  nextSeq: number;
  complete: boolean;
  status: string | null;
  truncated: boolean;
  legacy: boolean;
}

/** One line of a running app's log (never stored). */
export interface RuntimeLogLine {
  id: string;
  at: number;
  stream: "stdout" | "stderr";
  level?: string;
  text: string;
  request?: { method?: string; path?: string; status?: number };
}

export type RuntimeEndReason = "idle" | "max_duration" | "redeployed" | "error" | "upstream_closed";

/** What backend/logs streams for runtime logs, one JSON object per line. */
export type RuntimeLogEvent =
  | { type: "line"; line: RuntimeLogLine }
  | { type: "notice"; text: string }
  | { type: "end"; reason: RuntimeEndReason; message: string }
  | { type: "heartbeat" };

/** What backend/logs streams for a build log. */
export type BuildStreamEvent = { type: "entry"; entry: LogEntry } | { type: "done"; status: string | null } | { type: "heartbeat" };

/** `[12:03:04] [render] text`, the same rendering as backend/logs. */
export function entryToText(entry: Pick<LogEntry, "at" | "source" | "text">): string {
  const time = Number.isFinite(entry.at) && entry.at > 0 ? new Date(entry.at).toISOString().slice(11, 19) : "--:--:--";
  return `[${time}] [${entry.source}] ${entry.text}`;
}
