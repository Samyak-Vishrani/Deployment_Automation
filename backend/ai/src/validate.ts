import { redact } from "@orbitops/integration-common/redact";
import type { AnalysisResult, ContextBundle, Evidence, Problem, Severity, Step, StepWhere, Verdict } from "./types";

const VERDICTS: Verdict[] = ["healthy", "degraded", "failing", "unknown"];
const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
const WHERE: StepWhere[] = ["configure", "settings", "environment", "repository", "provider_dashboard", "redeploy"];
const STATUSES = ["ok", "warning", "failing", "unknown"] as const;

/** Commands OrbitOps never suggests: they destroy data or history, or pipe the internet into a shell. */
const DESTRUCTIVE =
  /\brm\s+-[a-z]*r[a-z]*f|\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b|\bdelete\s+from\b|\bgit\s+push\b[^\n]*(?:-f\b|--force)|\bprisma\s+(?:migrate\s+reset|db\s+push\s+--force-reset)|\b(?:vercel|render)\s+(?:remove|rm|delete)\b|\bcurl\b[^|\n]*\|\s*(?:sh|bash)\b|\bmkfs\b|\bdd\s+if=/i;
/** Commands that would print or leak a secret. */
const LEAKY = /\bprintenv\b|^\s*env\s*$|\becho\s+["']?\$\{?[A-Z_]*(?:SECRET|TOKEN|KEY|PASSWORD|DATABASE_URL)|\bcat\s+[^\n]*\.env\b|NEXT_PUBLIC_[A-Z_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE)/i;

export class InvalidAnalysisError extends Error {}

const norm = (s: string) =>
  s
    .replace(/^\s*\d{2}:\d{2}:\d{2}\s+/, "") // a time prefix the model copied
    .replace(/^\s*\[[^\]]{1,40}\]\s*/, "") // a [source] tag the model copied
    .replace(/\s*\(×\d+\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Every line the model was shown, normalised, for the evidence guard. */
export function contextLines(bundle: ContextBundle): string[] {
  const lines: string[] = [];
  for (const c of bundle.components) {
    for (const e of c.log?.entries ?? []) lines.push(e.text);
    for (const e of c.previousSuccessLog?.entries ?? []) lines.push(e.text);
    for (const l of c.runtime?.lines ?? []) lines.push(l.text);
    for (const d of c.deployments) if (d.errorMessage) lines.push(d.errorMessage);
  }
  for (const p of bundle.preflight) lines.push(p.message);
  if (bundle.release?.errorMessage) lines.push(bundle.release.errorMessage);
  return lines.map(norm).filter((l) => l.length > 0);
}

/** True when a quoted line really appears in the context (exactly, or as a long enough part of one line). */
export function isRealEvidence(line: string, known: string[]): boolean {
  const n = norm(line);
  if (n.length < 4) return false;
  return known.some((k) => k === n || (n.length >= 12 && k.includes(n)) || (k.length >= 12 && n.includes(k)));
}

/**
 * Turns the model's JSON into a safe AnalysisResult:
 * - shape and enum checks (a bad shape throws InvalidAnalysisError);
 * - component ids not in the bundle are dropped;
 * - **the evidence guard**: quoted lines that are not in the context are
 *   dropped, and a problem left with no evidence is capped at 0.3 confidence;
 * - steps with destructive or secret-leaking commands lose the command, with a note;
 * - steps renumbered 1..n; every string redacted once more.
 */
export function validateResult(value: unknown, bundle: ContextBundle): { result: AnalysisResult; warnings: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidAnalysisError("The model did not return an object.");
  const raw = value as Record<string, unknown>;
  const warnings: string[] = [];
  const ids = new Set(bundle.components.map((c) => c.id));
  const known = contextLines(bundle);
  const text = (v: unknown, max = 4000) => (typeof v === "string" ? redact(v).slice(0, max) : "");
  const nullableText = (v: unknown, max = 500) => (typeof v === "string" && v.trim() ? redact(v).slice(0, max) : null);
  const idOrNull = (v: unknown) => (typeof v === "string" && ids.has(v) ? v : null);

  if (!VERDICTS.includes(raw.verdict as Verdict)) throw new InvalidAnalysisError("The model returned an unknown verdict.");
  if (!Array.isArray(raw.problems) || !Array.isArray(raw.steps)) throw new InvalidAnalysisError("The model left out problems or steps.");

  let dropped = 0;
  const problems: Problem[] = raw.problems.slice(0, 8).map((item, i) => {
    const p = (item ?? {}) as Record<string, unknown>;
    const evidence: Evidence[] = (Array.isArray(p.evidence) ? p.evidence : [])
      .slice(0, 4)
      .map((e) => (e ?? {}) as Record<string, unknown>)
      .filter((e) => {
        const ok = typeof e.line === "string" && isRealEvidence(e.line, known);
        if (!ok) dropped++;
        return ok;
      })
      .map((e) => ({
        componentId: idOrNull(e.componentId),
        source: text(e.source, 60) || "log",
        line: text(e.line, 1000),
        deploymentId: typeof e.deploymentId === "string" ? e.deploymentId.slice(0, 64) : null,
      }));
    const confidence = Math.min(1, Math.max(0, typeof p.confidence === "number" ? p.confidence : 0.5));
    return {
      id: typeof p.id === "string" && p.id ? p.id.slice(0, 20) : `p${i + 1}`,
      title: text(p.title, 200) || "Problem",
      severity: SEVERITIES.includes(p.severity as Severity) ? (p.severity as Severity) : "medium",
      category: text(p.category, 60) || "UNKNOWN",
      componentIds: (Array.isArray(p.componentIds) ? p.componentIds : []).filter((x): x is string => typeof x === "string" && ids.has(x)),
      rootCause: text(p.rootCause, 2000),
      confidence: evidence.length === 0 ? Math.min(confidence, 0.3) : confidence,
      evidence,
    };
  });
  if (dropped > 0) warnings.push(`${dropped} quoted log line${dropped === 1 ? " was" : "s were"} not found in the logs and ${dropped === 1 ? "was" : "were"} removed.`);

  const problemIds = new Set(problems.map((p) => p.id));
  let unsafe = 0;
  const steps: Step[] = raw.steps
    .slice(0, 12)
    .map((item) => (item ?? {}) as Record<string, unknown>)
    .map((s) => {
      let command = nullableText(s.command, 400);
      let detail = text(s.detail, 2000);
      if (command && (DESTRUCTIVE.test(command) || LEAKY.test(command))) {
        unsafe++;
        command = null;
        detail += " (A suggested command was removed because it could destroy data or reveal a secret.)";
      }
      return {
        order: 0,
        title: text(s.title, 200) || "Step",
        detail,
        problemIds: (Array.isArray(s.problemIds) ? s.problemIds : []).filter((x): x is string => typeof x === "string" && problemIds.has(x)),
        where: WHERE.includes(s.where as StepWhere) ? (s.where as StepWhere) : "configure",
        componentId: idOrNull(s.componentId),
        command,
        file: nullableText(s.file, 300),
        envKey: typeof s.envKey === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(s.envKey) ? s.envKey : null,
      };
    })
    .filter((s) => !(DESTRUCTIVE.test(s.title) || DESTRUCTIVE.test(s.detail)));
  steps.forEach((s, i) => (s.order = i + 1));
  if (unsafe > 0) warnings.push(`${unsafe} unsafe command${unsafe === 1 ? " was" : "s were"} removed from the steps.`);

  const components = (Array.isArray(raw.components) ? raw.components : [])
    .map((item) => (item ?? {}) as Record<string, unknown>)
    .filter((c) => typeof c.componentId === "string" && ids.has(c.componentId))
    .map((c) => ({
      componentId: c.componentId as string,
      status: STATUSES.includes(c.status as (typeof STATUSES)[number]) ? (c.status as (typeof STATUSES)[number]) : "unknown",
      note: text(c.note, 300),
    }));

  const verdict = raw.verdict as Verdict;
  return {
    result: {
      verdict,
      summary: text(raw.summary, 1500),
      problems: verdict === "healthy" ? [] : problems,
      steps: verdict === "healthy" ? [] : steps,
      components,
      providerNotes: nullableText(raw.providerNotes, 3000),
      followUps: (Array.isArray(raw.followUps) ? raw.followUps : []).filter((x): x is string => typeof x === "string").slice(0, 5).map((x) => redact(x).slice(0, 300)),
    },
    warnings,
  };
}
