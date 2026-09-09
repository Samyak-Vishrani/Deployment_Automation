"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LogViewer } from "@/components/LogViewer";
import { PipelineStageList } from "@/components/PipelineStageList";
import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePlatform } from "@/lib/platform/context";
import type { AiInsight, LogEntry, PipelineRun, Project } from "@/lib/platform/types";
import { relativeTime, shortDate, shortTime } from "@/lib/format";

export default function PipelineDetailPage() {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();
  const platform = usePlatform();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async () => {
    const [projectItem, runItem, logItems, insightItems] = await Promise.all([platform.getProject(projectId), platform.getPipelineRun(runId), platform.getPipelineLogs(runId), platform.getAiInsights(projectId)]);
    setProject(projectItem); setRun(runItem); setLogs(logItems); setInsights(insightItems); setLoading(false);
  }, [platform, projectId, runId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  const isActive = run?.status === "queued" || run?.status === "running";
  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => void load(), 900);
    return () => window.clearInterval(timer);
  }, [isActive, load]);

  const insight = useMemo(() => run?.status === "failed" ? insights.find((item) => item.runId === runId) : undefined, [insights, run?.status, runId]);

  const cancel = async () => {
    setActionBusy(true);
    try { await platform.cancelPipeline(runId); await load(); } finally { setActionBusy(false); }
  };

  const rerun = async () => {
    if (!project) return;
    setActionBusy(true);
    try { const nextRun = await platform.triggerPipeline(project.id, run?.simulation ?? "success"); router.push(`/projects/${project.id}/pipelines/${nextRun.id}`); } finally { setActionBusy(false); }
  };

  if (loading) return <div className="loading-grid"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>;
  if (!run || !project) return <div className="panel module-placeholder"><div><div className="module-placeholder-icon"><Icon name="terminal" size={20} /></div><h3>Pipeline run not found</h3><p>This run is not available in the current project workspace.</p><Link href={`/projects/${projectId}/pipelines`} className="button button-primary" style={{ marginTop: 18 }}>Back to pipelines</Link></div></div>;

  return (
    <>
      <Link href={`/projects/${project.id}/pipelines`} className="back-link"><Icon name="chevron-left" size={14} /> Back to pipeline runs</Link>
      <div className="page-header"><div className="pipeline-detail-header"><span className="run-number">#{run.number}</span><div className="run-title"><p className="eyebrow">Pipeline run</p><h1>{run.commitMessage}</h1><p>{project.name} · {run.branch} · started {relativeTime(run.startedAt)}</p><div className="run-title-meta"><StatusPill status={run.status} />{isActive ? <span className="meta-chip"><span className="live-dot" /> Watching live state</span> : null}<span className="meta-chip"><Icon name="code" size={11} /> {run.commitSha}</span></div></div></div><div className="run-actions">{isActive ? <button className="button button-danger" type="button" onClick={() => void cancel()} disabled={actionBusy}><Icon name="x" size={14} /> Cancel</button> : <button className="button button-secondary" type="button" onClick={() => void rerun()} disabled={actionBusy}><Icon name="refresh" size={14} /> Run again</button>}<a className="button button-ghost" href={run.workflowUrl} target="_blank" rel="noreferrer">Open workflow <Icon name="external" size={14} /></a></div></div>

      <div className="run-summary"><div className="run-summary-item"><span>Started</span><strong>{shortDate(run.startedAt)} · {shortTime(run.startedAt)}</strong></div><div className="run-summary-item"><span>Trigger</span><strong>{run.triggerType === "push" ? "Repository push" : "Manual run"}</strong></div><div className="run-summary-item"><span>Commit</span><strong>{run.commitSha}</strong></div><div className="run-summary-item"><span>Duration</span><strong>{run.duration ?? (isActive ? "In progress" : "—")}</strong></div></div>

      <div className="pipeline-columns"><div className="panel panel-pad"><div className="panel-title-row"><div><h3>Delivery stages</h3><p>Every handoff from source to runtime health.</p></div><StatusPill status={run.status} /></div><PipelineStageList stages={run.stages} /></div><div><div className="panel panel-pad"><div className="panel-title-row"><div><h3>Pipeline output</h3><p>Evidence attached to this run.</p></div><span className="tiny-label">{logs.length} lines</span></div><LogViewer logs={logs} /></div>{insight ? <div className="ai-insight"><div className="ai-insight-head"><span className="ai-insight-icon"><Icon name="sparkles" size={16} /></span><div><h3>AI-assisted diagnosis</h3><p>{insight.title}</p></div><span className="confidence">{insight.confidence}% confidence</span></div><div className="insight-grid"><div className="insight-block"><span>Summary</span><p>{insight.summary}</p></div><div className="insight-block"><span>Recommended action</span><p>{insight.recommendedAction}</p></div></div><div className="insight-block" style={{ marginTop: 15 }}><span>Probable cause</span><p>{insight.probableCause}</p></div><div className="evidence-list">{insight.evidence.map((item) => <div key={item}><Icon name="check" size={12} />{item}</div>)}</div></div> : null}</div></div>

      {run.status === "succeeded" ? <div className="callout" style={{ marginTop: 14 }}><Icon name="check" size={16} /><span>This run completed successfully. The deployment worker can now apply the immutable image tag and wait for Kubernetes readiness.</span><Link className="text-link" href={`/projects/${project.id}/deployments`}>View deployment <Icon name="arrow-up-right" size={12} /></Link></div> : null}
      {run.status === "failed" ? <div className="callout" style={{ marginTop: 14, borderColor: "rgba(243,126,142,.25)", background: "rgba(177,60,79,.09)", color: "#ffb6c0" }}><Icon name="circle-help" size={16} /><span>{run.failureReason ?? "The run stopped before a healthy deployment was produced."}</span></div> : null}
    </>
  );
}
