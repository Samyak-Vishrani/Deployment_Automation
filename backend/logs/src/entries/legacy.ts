import type { LogEntry } from "@orbitops/integration-common/contract";

/**
 * A line of a pre-Phase-12 log file (`[hh:mm:ss] text`, written by the main
 * backend's old DeploymentLogWriter). Those files carry no date and no
 * source, so the date comes from the file and the source is "orbitops".
 */
export function parseLegacyLine(line: string, seq: number, day: Date): LogEntry {
  const match = /^\[(\d{2}):(\d{2}):(\d{2})\] ?(.*)$/.exec(line);
  if (!match) {
    return { seq, at: 0, source: "orbitops", phase: "build", stream: "stdout", text: line };
  }
  const [, h, m, s, text] = match;
  const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(h), Number(m), Number(s));
  return { seq, at, source: "orbitops", phase: "build", stream: text.startsWith("==> ") ? "info" : "stdout", text };
}
