/**
 * Whether a log line reads as an error, for highlighting and the "errors
 * only" filter. A verbatim copy lives in frontend/lib/deploy/log-format.ts
 * (keep the two identical; a frontend test checks).
 */
const ERROR_WORDS = /\b(?:error|errors|failed|failure|fatal|exception|panic|traceback)\b|\bERR!/i;

export function isErrorLine(entry: { stream?: string; source?: string; level?: string; text: string }): boolean {
  // `docker build --progress plain` writes all its progress to stderr, so stderr alone means nothing there.
  if (entry.stream === "stderr" && entry.source !== "docker") return true;
  if (entry.level && /^(error|fatal|critical)$/i.test(entry.level)) return true;
  return ERROR_WORDS.test(entry.text);
}
