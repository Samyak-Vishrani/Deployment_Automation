import { isErrorish } from "../rules/errorish";
import type { ContextBundle } from "../types";

export interface TimelineLine {
  at: number;
  component: string;
  source: string;
  text: string;
  error: boolean;
}

/**
 * The combined, time-ordered log of every component: build-log excerpts and
 * runtime lines merged by time, each tagged with its component and source.
 *
 * Phase 12 kept logs strictly per component and left this combined view to
 * the AI; it exists only inside the prompt, never in the UI. Capped at
 * `limit` lines around the first error-looking line, which is where
 * cross-component causes show (a backend that failed before the frontend was
 * built, say).
 */
export function combinedTimeline(bundle: ContextBundle, limit = 200): TimelineLine[] {
  const all: TimelineLine[] = [];
  for (const c of bundle.components) {
    for (const e of c.log?.entries ?? []) {
      all.push({ at: e.at, component: c.name, source: e.source, text: e.text, error: isErrorish(e) });
    }
    for (const l of c.runtime?.lines ?? []) {
      all.push({ at: l.at, component: c.name, source: `${c.provider} runtime`, text: l.text, error: isErrorish(l) });
    }
  }
  all.sort((a, b) => a.at - b.at);
  if (all.length <= limit) return all;

  const firstError = all.findIndex((l) => l.error);
  const center = firstError >= 0 ? firstError : all.length - 1;
  const before = Math.floor(limit * 0.3);
  const start = Math.max(0, Math.min(center - before, all.length - limit));
  return all.slice(start, start + limit);
}

export function renderTimeline(lines: TimelineLine[]): string {
  if (lines.length === 0) return "";
  const time = (at: number) => (at > 0 ? new Date(at).toISOString().slice(11, 19) : "--:--:--");
  return `<timeline>\n${lines.map((l) => `${time(l.at)} [${l.component} · ${l.source}] ${l.text}`).join("\n")}\n</timeline>`;
}
