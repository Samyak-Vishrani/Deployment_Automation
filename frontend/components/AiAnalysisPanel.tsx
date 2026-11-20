"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { sendAnalysisFeedback } from "@/lib/deploy/client";
import { evidenceHref, stepHref, VERDICT_LABEL, verdictOf, WHERE_LABEL } from "@/lib/deploy/ai-format";
import type { AiVerdict, AnalysisView } from "@/lib/deploy/types";
import { relativeTime } from "@/lib/format";

const VERDICT_TONE: Record<AiVerdict, string> = {
  healthy: "ai-healthy",
  degraded: "ai-degraded",
  failing: "ai-failing",
  unknown: "ai-unknown",
};

const STATUS_TONE = { ok: "ai-healthy", warning: "ai-degraded", failing: "ai-failing", unknown: "ai-unknown" } as const;

/**
 * One AI analysis (Phase 13): the verdict, each problem with the log lines
 * that show it (each links to that component's log), the ordered fix steps,
 * and a status per component. Steps are suggestions: nothing was changed.
 */
export function AiAnalysisPanel({
  view,
  projectId,
  componentNames,
  onRerun,
  onClose,
}: {
  view: AnalysisView;
  projectId: string;
  /** componentId → display name ("docker" included). */
  componentNames: Record<string, string>;
  onRerun?: () => void;
  onClose?: () => void;
}) {
  const r = view.result;
  const verdictKey = verdictOf(r);
  const verdict = { label: VERDICT_LABEL[verdictKey], tone: VERDICT_TONE[verdictKey] };
  const [done, setDone] = useState<Set<number>>(new Set());
  const [helpful, setHelpful] = useState<boolean | null>(view.helpful);
  const [copied, setCopied] = useState<string | null>(null);
  const name = (id: string | null) => (id ? (componentNames[id] ?? id) : "the project");

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const feedback = async (value: boolean) => {
    setHelpful(value);
    await sendAnalysisFeedback(view.id, value).catch(() => setHelpful(view.helpful));
  };

  return (
    <div className={`panel panel-pad ai-panel ${verdict.tone}`}>
      <div className="ai-head">
        <div>
          <p className="eyebrow">
            AI {view.scope === "project" ? "diagnosis" : `analysis · ${name(view.componentId)}`}
          </p>
          <h3>
            <span className={`ai-verdict ${verdict.tone}`}>{verdict.label}</span> {r.summary}
          </h3>
          {view.question ? <p className="field-hint">Question: “{view.question}”</p> : null}
        </div>
        <div className="ai-head-meta">
          <span className="meta-chip">{view.engine === "openai" ? (view.model ?? "OpenAI") : "rules only"}</span>
          {view.cached ? <span className="meta-chip" title="The same question and context within 10 minutes">cached</span> : null}
          <span className="tiny-label">{relativeTime(view.createdAt)}</span>
          {onClose ? (
            <button className="button button-ghost" type="button" onClick={onClose} aria-label="Close the analysis">
              <Icon name="x" size={13} />
            </button>
          ) : null}
        </div>
      </div>

      {view.notice ? (
        <div className="callout" style={{ margin: "10px 0" }}>
          <Icon name="circle-help" size={15} />
          <span>{view.notice}</span>
        </div>
      ) : null}

      {view.scope === "project" && r.components.length > 0 ? (
        <div className="ai-components">
          {r.components.map((c) => (
            <span key={c.componentId} className={`ai-chip ${STATUS_TONE[c.status]}`} title={c.note}>
              {name(c.componentId)}: {c.status}
            </span>
          ))}
        </div>
      ) : null}

      {r.problems.length > 0 ? (
        <section className="ai-section">
          <h4>Problems</h4>
          {r.problems.map((p) => (
            <div key={p.id} className={`ai-problem ai-sev-${p.severity}`}>
              <div className="ai-problem-head">
                <strong>{p.title}</strong>
                <span className={`ai-chip ai-sev-${p.severity}`}>{p.severity}</span>
                {p.componentIds.map((id) => (
                  <span key={id} className="ai-chip">
                    {name(id)}
                  </span>
                ))}
                <span className="ai-confidence" title={`Confidence ${Math.round(p.confidence * 100)}%`}>
                  <span style={{ width: `${Math.round(p.confidence * 100)}%` }} />
                </span>
              </div>
              <p>{p.rootCause}</p>
              {p.evidence.length ? (
                <div className="ai-evidence">
                  {p.evidence.map((e, i) => (
                    <Link key={i} href={evidenceHref(projectId, e.componentId, e.deploymentId)} title="Open this log">
                      <code>{e.line}</code>
                      <span className="tiny-label">
                        {name(e.componentId)} · {e.source}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="field-hint">No log line confirms this one; treat it as a guess.</p>
              )}
            </div>
          ))}
        </section>
      ) : null}

      {r.steps.length > 0 ? (
        <section className="ai-section">
          <h4>What to do</h4>
          <ol className="ai-steps">
            {r.steps.map((s) => {
              const href = stepHref(projectId, s.where);
              return (
                <li key={s.order} className={done.has(s.order) ? "ai-step-done" : ""}>
                  <label className="ai-step-check">
                    <input
                      type="checkbox"
                      checked={done.has(s.order)}
                      onChange={() =>
                        setDone((prev) => {
                          const next = new Set(prev);
                          if (next.has(s.order)) next.delete(s.order);
                          else next.add(s.order);
                          return next;
                        })
                      }
                    />
                    <strong>{s.title}</strong>
                  </label>
                  <span className="ai-chip">{WHERE_LABEL[s.where]}</span>
                  {s.componentId ? <span className="ai-chip">{name(s.componentId)}</span> : null}
                  <p>{s.detail}</p>
                  <div className="ai-step-extras">
                    {s.command ? (
                      <button type="button" className="ai-code" onClick={() => void copy(s.command!)} title="Copy">
                        <code>{s.command}</code> {copied === s.command ? "copied" : <Icon name="file-text" size={11} />}
                      </button>
                    ) : null}
                    {s.file ? <span className="ai-chip">file: {s.file}</span> : null}
                    {s.envKey ? <span className="ai-chip">env: {s.envKey}</span> : null}
                    {href ? (
                      <Link className="text-link" href={href}>
                        Open {WHERE_LABEL[s.where]} <Icon name="arrow-up-right" size={11} />
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {r.providerNotes ? (
        <section className="ai-section">
          <h4>Provider notes</h4>
          <p>{r.providerNotes}</p>
        </section>
      ) : null}

      {r.followUps.length ? (
        <section className="ai-section">
          <h4>To be more certain, the AI would need</h4>
          <ul>
            {r.followUps.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="ai-foot">
        <span className="field-hint">Redacted logs and settings were sent to OpenAI. Suggestions can be wrong; nothing was changed.</span>
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span className="tiny-label">Helpful?</span>
          <button type="button" className={`button button-ghost${helpful === true ? " ai-voted" : ""}`} onClick={() => void feedback(true)} aria-label="Helpful">
            👍
          </button>
          <button type="button" className={`button button-ghost${helpful === false ? " ai-voted" : ""}`} onClick={() => void feedback(false)} aria-label="Not helpful">
            👎
          </button>
          {onRerun ? (
            <button type="button" className="button button-secondary" onClick={onRerun}>
              <Icon name="refresh" size={13} /> Re-run
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}
