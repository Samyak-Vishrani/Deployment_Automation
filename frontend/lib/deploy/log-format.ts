import type { LogSource } from "./types";

/** Labels and colours of each log source (the badges on every line). */
export const SOURCE_LABEL: Record<LogSource, string> = {
  orbitops: "OrbitOps",
  vercel: "Vercel",
  render: "Render",
  neon: "Neon",
  docker: "Docker",
};

/** `12:03:04` in the viewer's own time zone. */
export function formatTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "--:--:--";
  return new Date(at).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** `[12:03:04] [render] text`, for Copy and the runtime download. */
export function entryToText(entry: { at: number; source: LogSource; text: string }): string {
  return `[${formatTime(entry.at)}] [${entry.source}] ${entry.text}`;
}

// The error rule below is a verbatim copy of backend/logs/src/entries/errors.ts
// (a test checks the two stay identical).
const ERROR_WORDS = /\b(?:error|errors|failed|failure|fatal|exception|panic|traceback)\b|\bERR!/i;

export function isErrorLine(entry: { stream?: string; source?: string; level?: string; text: string }): boolean {
  // `docker build --progress plain` writes all its progress to stderr, so stderr alone means nothing there.
  if (entry.stream === "stderr" && entry.source !== "docker") return true;
  if (entry.level && /^(error|fatal|critical)$/i.test(entry.level)) return true;
  return ERROR_WORDS.test(entry.text);
}
