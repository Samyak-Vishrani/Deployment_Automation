"use client";

import { useEffect, useState } from "react";
import { getAnalysis, listAnalyses } from "@/lib/deploy/client";
import type { AnalysisSummary, AnalysisView } from "@/lib/deploy/types";
import { relativeTime } from "@/lib/format";

/** The project's last few AI analyses (Phase 13); one click opens it again. */
export function AiHistory({
  projectId,
  componentNames,
  refreshKey,
  onOpen,
}: {
  projectId: string;
  componentNames: Record<string, string>;
  /** Changes whenever a new analysis finished, to reload the list. */
  refreshKey: string | null;
  onOpen: (view: AnalysisView) => void;
}) {
  const [items, setItems] = useState<AnalysisSummary[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    listAnalyses(projectId, 5)
      .then((list) => live && setItems(list))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [projectId, refreshKey]);

  if (!items || items.length === 0) return null;
  return (
    <details className="ai-history-wrap">
      <summary className="tiny-label">Past analyses ({items.length})</summary>
      <div className="ai-history">
        {items.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() =>
              void getAnalysis(a.id)
                .then(onOpen)
                .catch((e: Error) => setError(e.message))
            }
          >
            <span>
              <strong>{a.scope === "project" ? "Whole project" : (componentNames[a.componentId ?? ""] ?? a.componentId)}</strong>
              {" · "}
              {a.verdict ?? "—"}
              {a.question ? ` · “${a.question.slice(0, 60)}”` : ""}
            </span>
            <span className="tiny-label">
              {a.engine === "rules" ? "rules · " : ""}
              {relativeTime(a.createdAt)}
            </span>
          </button>
        ))}
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </details>
  );
}
