/**
 * Whether a line reads as an error: the same rule as backend/logs'
 * isErrorLine (src/entries/errors.ts), so the AI trims logs around the same
 * lines the viewer highlights.
 */
const ERROR_WORDS = /\b(?:error|errors|failed|failure|fatal|exception|panic|traceback)\b|\bERR!/i;

export function isErrorish(line: { stream?: string; source?: string; level?: string; text: string }): boolean {
  if (line.stream === "stderr" && line.source !== "docker") return true;
  if (line.level && /^(error|fatal|critical)$/i.test(line.level)) return true;
  return ERROR_WORDS.test(line.text);
}
