import type { LogEntry } from "@orbitops/integration-common/contract";
import { isErrorLine } from "./errors";

/** A line of an excerpt. `repeat` > 1 = the same text ran that many times in a row. */
export type ExcerptEntry = LogEntry & { repeat?: number };

export interface Excerpt {
  entries: ExcerptEntry[];
  totalLines: number;
  errorLines: number;
  /** Lines were left out. */
  truncated: boolean;
}

export interface ExcerptOptions {
  maxLines?: number;
  head?: number;
  tail?: number;
  context?: number;
}

/**
 * The errors-first excerpt of one deployment's log (Phase 13, for the AI):
 * every error-looking line with `context` lines either side, plus the first
 * `head` and last `tail` lines, with runs of identical text collapsed. When
 * that is still over `maxLines`, it narrows (±2 context, 10 head, 60 tail),
 * then keeps only error lines. Entries stay in seq order; gaps in seq show
 * what was left out.
 */
export function excerpt(entries: LogEntry[], options: ExcerptOptions = {}): Excerpt {
  const maxLines = Math.min(Math.max(options.maxLines ?? 400, 20), 1500);
  const errorIdx = entries.flatMap((e, i) => (isErrorLine(e) ? [i] : []));

  const pick = (head: number, tail: number, context: number): number[] => {
    const keep = new Set<number>();
    for (let i = 0; i < Math.min(head, entries.length); i++) keep.add(i);
    for (let i = Math.max(0, entries.length - tail); i < entries.length; i++) keep.add(i);
    for (const i of errorIdx) for (let j = Math.max(0, i - context); j <= Math.min(entries.length - 1, i + context); j++) keep.add(j);
    return [...keep].sort((a, b) => a - b);
  };

  let picked = collapse(pick(options.head ?? 20, options.tail ?? 150, options.context ?? 5).map((i) => entries[i]));
  if (picked.length > maxLines) picked = collapse(pick(10, 60, 2).map((i) => entries[i]));
  if (picked.length > maxLines) {
    const errors = collapse(errorIdx.map((i) => entries[i]));
    picked = errors.length > maxLines ? [...errors.slice(0, Math.floor(maxLines / 2)), ...errors.slice(-Math.ceil(maxLines / 2))] : errors;
  }

  const shown = picked.reduce((n, e) => n + (e.repeat ?? 1), 0);
  return { entries: picked, totalLines: entries.length, errorLines: errorIdx.length, truncated: shown < entries.length };
}

/** Consecutive (by seq) entries with the same text become one with `repeat`. */
function collapse(list: LogEntry[]): ExcerptEntry[] {
  const out: ExcerptEntry[] = [];
  for (const entry of list) {
    const last = out.at(-1);
    if (last && last.text === entry.text && last.source === entry.source && entry.seq === last.seq + (last.repeat ?? 1)) {
      last.repeat = (last.repeat ?? 1) + 1;
    } else {
      out.push({ ...entry });
    }
  }
  return out;
}
