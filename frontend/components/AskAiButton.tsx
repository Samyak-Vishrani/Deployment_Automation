"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import type { ApiError } from "@/lib/api/error";
import { analyzeComponent, diagnoseProject } from "@/lib/deploy/client";
import type { AnalysisView } from "@/lib/deploy/types";

export type AskAiTarget =
  | { scope: "project"; projectId: string }
  | { scope: "component"; projectId: string; componentId: string; deploymentId?: string | null };

const STAGES = ["Gathering settings and logs…", "Analysing with AI…", "Checking the answer against the logs…"];

/**
 * "Diagnose with AI" / "Analyze with AI" (Phase 13): a button with an
 * optional question. Runs only when clicked; an analysis takes up to about a
 * minute, so the stage text moves on while it waits.
 */
export function AskAiButton({
  target,
  label,
  primary = false,
  onResult,
}: {
  target: AskAiTarget;
  label: string;
  primary?: boolean;
  onResult: (view: AnalysisView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!running) return;
    const timers = [setTimeout(() => setStage(1), 2500), setTimeout(() => setStage(2), 15000)];
    return () => timers.forEach(clearTimeout);
  }, [running]);

  async function run(force = false) {
    setRunning(true);
    setStage(0);
    setError("");
    try {
      const options = { question: question.trim() || undefined, force };
      const view =
        target.scope === "project"
          ? await diagnoseProject(target.projectId, options)
          : await analyzeComponent(target.projectId, target.componentId, { ...options, deploymentId: target.deploymentId ?? null });
      setOpen(false);
      onResult(view);
    } catch (e) {
      const err = e as ApiError;
      setError(
        err.code === "ai_service_unavailable"
          ? "The AI service is not running. Start it in Terminal 7: cd backend/ai && npm run dev."
          : err.message || "The analysis failed.",
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <span className="ai-ask">
      <button
        className={`button ${primary ? "button-primary" : "button-secondary"}`}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={running}
        title="Ask the AI what is wrong and how to fix it. Runs only when you click."
      >
        <Icon name="sparkles" size={14} /> {running ? STAGES[stage] : label}
      </button>
      {open && !running ? (
        <div className="ai-ask-pop" role="dialog" aria-label={label}>
          <label className="field-label">
            Question (optional)
            <textarea
              rows={2}
              maxLength={500}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. why does /db return 500?"
            />
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="button button-ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="button button-primary" type="button" onClick={() => void run()}>
              <Icon name="sparkles" size={13} /> Analyse
            </button>
          </div>
          <p className="field-hint">Redacted logs and settings (never env var values) are sent to OpenAI. Nothing is changed.</p>
        </div>
      ) : null}
      {error ? (
        <span className="form-error ai-ask-error">
          <Icon name="x" size={13} />
          <span>{error}</span>
        </span>
      ) : null}
    </span>
  );
}
