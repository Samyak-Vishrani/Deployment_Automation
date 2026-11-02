import type { LogLine } from "../types";

/**
 * One entry of `GET /v3/deployments/:id/events`. Vercel has used two shapes:
 * the text and ids under `payload`, or (older) at the top level. Both are read.
 */
export interface VercelLogEvent {
  type?: string;
  created?: number;
  date?: number;
  id?: string;
  serial?: string;
  text?: string;
  payload?: {
    text?: string;
    id?: string;
    serial?: string;
    date?: number;
    info?: { type?: string };
  };
}

/** Build output we show. Request logs of the running site, delimiters etc. are dropped. */
const KEPT: Record<string, LogLine["stream"]> = {
  stdout: "stdout",
  stderr: "stderr",
  command: "info",
  fatal: "stderr",
  exit: "info",
};

export function toLogLine(event: VercelLogEvent): LogLine | null {
  const type = event.type ?? "stdout";
  const stream = KEPT[type];
  if (!stream) return null;

  const raw = event.payload?.text ?? event.text;
  if (typeof raw !== "string") return null;
  // A trailing newline would become an empty line in our viewer.
  const text = raw.replace(/\r?\n$/, "");
  if (type !== "command" && text.trim() === "") return null;

  const at = Number(event.created ?? event.payload?.date ?? event.date ?? 0);
  const id = event.payload?.id ?? event.id ?? event.payload?.serial ?? event.serial ?? `${at}:${text}`;
  return { id: String(id), at, stream, text: type === "command" ? `$ ${text}` : text };
}

export function toLogLines(events: unknown): LogLine[] {
  if (!Array.isArray(events)) return [];
  const lines: LogLine[] = [];
  for (const event of events) {
    if (event && typeof event === "object") {
      const line = toLogLine(event as VercelLogEvent);
      if (line) lines.push(line);
    }
  }
  return lines;
}
