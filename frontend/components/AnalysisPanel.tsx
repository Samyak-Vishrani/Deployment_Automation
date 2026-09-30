"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { analyzeProject, getProjectAnalysis } from "@/lib/deploy/client";
import { logAnalysis } from "@/lib/deploy/log-analysis";
import type { AnalysisComponent, ProjectAnalysis } from "@/lib/deploy/types";
import { relativeTime } from "@/lib/format";

const ROLE_TONE: Record<string, string> = {
  frontend: "status-blue",
  backend: "status-green",
  unknown: "status-neutral",
};

/** "Install", "Build", "Start" and "Output" as one stack, skipping what does not apply. */
function Commands({ component }: { component: AnalysisComponent }) {
  const rows: [string, string | null][] = [
    ["install", component.installCmd],
    ["build", component.buildCmd],
    ["start", component.startCmd],
    ["output", component.outputDir],
  ];
  const present = rows.filter(([, value]) => value);

  if (present.length === 0) {
    return <span className="muted">Defined by the Dockerfile</span>;
  }
  return (
    <div style={{ display: "grid", gap: 5 }}>
      {present.map(([label, value]) => (
        <div key={label}>
          <span className="tiny-label">{label}</span>{" "}
          <code className="commit-code">{value}</code>
        </div>
      ))}
    </div>
  );
}

/**
 * What the repository analysis found: one row per deployable app, plus the
 * database suggestion and anything the analysis had to skip.
 *
 * Read-only on purpose. Changing a path or a command belongs to the configure
 * step, which stores the user's version separately so that re-analysing can
 * never overwrite it.
 */
export function AnalysisPanel({ projectId }: { projectId: string }) {
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const startedAt = performance.now();
      const result = await getProjectAnalysis(projectId);
      logAnalysis("GET /analysis (latest snapshot)", result, startedAt);
      setAnalysis(result);
      setError("");
    } catch (e) {
      console.error("[analysis] GET /analysis failed:", e);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function onAnalyze() {
    setRunning(true);
    setError("");
    try {
      const startedAt = performance.now();
      console.log(`[analysis] POST /analyze for project ${projectId}…`);
      const result = await analyzeProject(projectId);
      logAnalysis(
        result.reused ? "POST /analyze (reused: commit unchanged)" : "POST /analyze (new snapshot)",
        result,
        startedAt,
      );
      setAnalysis(result);
    } catch (e) {
      // ApiError carries the backend's status and error code (repo_not_found, …).
      console.error("[analysis] POST /analyze failed:", e);
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const analysed = Boolean(analysis?.analysisId);

  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Repository analysis</h2>
          <p>
            {analysed && analysis
              ? `${analysis.branch} at ${analysis.commitSha?.slice(0, 7)} · analysed ${relativeTime(analysis.analyzedAt)}`
              : "Finds the apps in this repository and how each one builds and runs."}
          </p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => void onAnalyze()}
          disabled={running || loading}
        >
          <Icon name={analysed ? "refresh" : "search"} size={14} />
          {running ? "Analysing…" : analysed ? "Re-analyze" : "Analyze repository"}
        </button>
      </div>

      {error ? (
        <div className="form-error" style={{ marginBottom: 14 }}>
          <Icon name="x" size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      {analysis?.reused ? (
        <div className="callout" style={{ marginBottom: 14 }}>
          <Icon name="check" size={15} />
          <span>
            No new commits on {analysis.branch} since the last analysis, so this is the same
            snapshot.
          </span>
        </div>
      ) : null}

      <div className="panel panel-pad">
        {loading ? (
          <div className="empty-inline">Loading analysis…</div>
        ) : !analysed || !analysis ? (
          <div className="empty-inline">
            Not analysed yet. Run the analysis to detect this repository&apos;s frontend and backend.
          </div>
        ) : analysis.components.length === 0 ? (
          <div className="empty-inline">
            No deployable app was detected at {analysis.commitSha?.slice(0, 7)}. The analysis looks
            for a package.json, a Python, Go, Rust, Java, Ruby or PHP manifest, or a Dockerfile.
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Role</th>
                  <th>Framework</th>
                  <th>Commands</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {analysis.components.map((component) => (
                  <tr key={component.id}>
                    <td className="primary-cell">
                      <code className="commit-code">
                        {component.path === "." ? "/ (root)" : component.path}
                      </code>
                    </td>
                    <td>
                      <span className={`status-pill ${ROLE_TONE[component.role ?? "unknown"]}`}>
                        {component.role ?? "unknown"}
                      </span>
                    </td>
                    <td className="cell-stack">
                      <strong>
                        {component.framework ?? "—"}
                        {component.detectedVersion ? ` ${component.detectedVersion}` : ""}
                      </strong>
                      <small>
                        {[
                          component.language,
                          component.packageManager,
                          component.runtimeVersion && `runtime ${component.runtimeVersion}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </td>
                    <td>
                      <Commands component={component} />
                    </td>
                    <td title={component.evidence.join("\n")}>
                      {component.confidence === null
                        ? "—"
                        : `${Math.round(component.confidence * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {analysed && analysis?.database?.detected ? (
        <div className="callout" style={{ marginTop: 14 }}>
          <Icon name="database" size={15} />
          <span>
            <strong>
              {analysis.database.suggestNeon
                ? "This project uses a SQL database. A Neon Postgres database is suggested."
                : `This project uses ${analysis.database.engine}, which Neon does not provide.`}
            </strong>
            <br />
            Found in: {analysis.database.evidence.join(", ")}
          </span>
        </div>
      ) : null}

      {analysed && analysis && analysis.warnings.length > 0 ? (
        <div className="panel panel-pad" style={{ marginTop: 14 }}>
          <div className="panel-title-row">
            <div>
              <h3>Analysis notes</h3>
              <p>What was skipped or could not be read. None of these stopped the analysis.</p>
            </div>
          </div>
          <div className="review-list">
            {analysis.warnings.map((warning, index) => (
              <div className="review-row" key={`${warning.code}-${index}`}>
                <span>{warning.code.replaceAll("_", " ")}</span>
                <strong>{warning.message}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
