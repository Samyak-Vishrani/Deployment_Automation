import type { LogEntry, LogSource } from "@orbitops/integration-common/contract";

export const LOG_SOURCES: readonly LogSource[] = ["orbitops", "vercel", "render", "neon", "docker"];

/** `[12:03:04] [render] text`: the plain-text form, for downloads, logTail and the legacy /logs. */
export function entryToText(entry: Pick<LogEntry, "at" | "source" | "text">): string {
  const time = Number.isFinite(entry.at) && entry.at > 0 ? new Date(entry.at).toISOString().slice(11, 19) : "--:--:--";
  return `[${time}] [${entry.source}] ${entry.text}`;
}

/** The last `maxBytes` of the log as text, whole lines only. */
export function tailText(entries: LogEntry[], maxBytes = 64 * 1024): string {
  let out = "";
  for (let i = entries.length - 1; i >= 0; i--) {
    const next = entryToText(entries[i]) + "\n";
    if (out.length + next.length > maxBytes) break;
    out = next + out;
  }
  return out;
}
