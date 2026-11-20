import { renderBundle } from "../prompts/render";
import { isErrorish } from "../rules/errorish";
import type { BundleComponent, BundleLog, ContextBundle, Hypothesis } from "../types";

/** A cheap token estimate (about 4 characters per token for English and logs). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Trims the bundle until its rendering fits `maxTokens`, in a fixed order
 * that keeps what matters most for a diagnosis:
 *
 * 1. the runtime lines of components with no problem;
 * 2. previous-success logs and deployments beyond the latest 3;
 * 3. log context: only head 10, tail 60 and the error-looking lines (±2);
 * 4. the logs of components with no problem;
 * 5. last, failing components down to their error-looking lines (100, then 40).
 *
 * Returns the trimmed copy and notes saying what was left out, so the prompt
 * (and the user) know.
 */
export function fitBundle(bundle: ContextBundle, hypotheses: Hypothesis[], maxTokens: number): { bundle: ContextBundle; notes: string[] } {
  const b: ContextBundle = structuredClone(bundle);
  const notes: string[] = [];
  const troubled = new Set(hypotheses.map((h) => h.componentId).filter(Boolean) as string[]);
  const healthy = (c: BundleComponent) => !troubled.has(c.id) && c.status !== "failed";
  const fits = () => estimateTokens(renderBundle(b)) <= maxTokens;

  const steps: Array<() => void> = [
    () => {
      for (const c of b.components.filter(healthy)) {
        if (c.runtime?.lines.length) {
          c.runtime = { lines: [], note: "trimmed: no problem detected" };
          notes.push(`Runtime lines of ${c.name} were left out (no problem detected there).`);
        }
      }
    },
    () => {
      for (const c of b.components) {
        if (c.previousSuccessLog) {
          c.previousSuccessLog = null;
          notes.push(`The previous successful log of ${c.name} was left out.`);
        }
        if (c.deployments.length > 3) c.deployments = c.deployments.slice(0, 3);
      }
    },
    () => {
      for (const c of b.components) if (c.log) c.log = focus(c.log, 10, 60, 2);
      notes.push("Logs were trimmed to their first and last lines and the lines around errors.");
    },
    () => {
      for (const c of b.components.filter(healthy)) {
        if (c.log) {
          c.log = null;
          notes.push(`The log of ${c.name} was left out (no problem detected there).`);
        }
      }
    },
    () => {
      for (const c of b.components) if (c.log) c.log = onlyErrors(c.log, 100);
      for (const c of b.components) if (c.runtime) c.runtime.lines = c.runtime.lines.slice(-30);
    },
    () => {
      for (const c of b.components) if (c.log) c.log = onlyErrors(c.log, 40);
      for (const c of b.components) if (c.runtime) c.runtime.lines = c.runtime.lines.filter((l) => isErrorish(l)).slice(-10);
      notes.push("Only error lines were kept; the logs were too long to send whole.");
    },
  ];

  for (const step of steps) {
    if (fits()) break;
    step();
  }
  return { bundle: b, notes: [...new Set(notes)] };
}

/** Head, tail, and the error-looking lines with `ctx` lines either side. */
function focus(log: BundleLog, head: number, tail: number, ctx: number): BundleLog {
  const keep = new Set<number>();
  log.entries.forEach((e, i) => {
    if (i < head || i >= log.entries.length - tail) keep.add(i);
    if (isErrorish(e)) for (let j = i - ctx; j <= i + ctx; j++) keep.add(j);
  });
  const entries = log.entries.filter((_, i) => keep.has(i));
  return { ...log, entries, truncated: log.truncated || entries.length < log.entries.length };
}

function onlyErrors(log: BundleLog, max: number): BundleLog {
  const errors = log.entries.filter((e) => isErrorish(e));
  const entries = (errors.length ? errors : log.entries.slice(-10)).slice(0, max);
  return { ...log, entries, truncated: true };
}
