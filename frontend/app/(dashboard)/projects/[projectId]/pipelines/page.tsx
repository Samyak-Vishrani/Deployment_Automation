"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { PageHeader, SectionHeading } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePlatform } from "@/lib/platform/context";
import type { PipelineRun, Project, RunStatus } from "@/lib/platform/types";
import { relativeTime } from "@/lib/format";

const filters: Array<{ label: string; value: "all" | RunStatus }> = [{ label: "All runs", value: "all" }, { label: "Running", value: "running" }, { label: "Succeeded", value: "succeeded" }, { label: "Failed", value: "failed" }];

export default function PipelinesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const platform = usePlatform();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [filter, setFilter] = useState<"all" | RunStatus>("all");
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    const [projectItem, runItems] = await Promise.all([platform.getProject(projectId), platform.listPipelineRuns(projectId)]);
    setProject(projectItem); setRuns(runItems);
  }, [platform, projectId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useEffect(() => {
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
    const timer = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(timer);
  }, [load, runs]);

  const visibleRuns = useMemo(() => filter === "all" ? runs : runs.filter((run) => run.status === filter), [filter, runs]);
  const trigger = async (simulation: "success" | "failure") => {
    setStarting(true);
    try { const run = await platform.triggerPipeline(projectId, simulation); router.push(`/projects/${projectId}/pipelines/${run.id}`); } finally { setStarting(false); }
  };

  if (!project) return <div className="panel module-placeholder"><div><div className="module-placeholder-icon"><Icon name="terminal" size={20} /></div><h3>Pipeline workspace unavailable</h3><p>We could not find this project in the current workspace.</p><Link href="/projects" className="button button-primary" style={{ marginTop: 18 }}>Back to projects</Link></div></div>;

  return (
    <>
      <Link href={`/projects/${project.id}`} className="back-link"><Icon name="chevron-left" size={14} /> {project.name}</Link>
      <PageHeader eyebrow="Delivery operations" title="Pipeline runs" description="Inspect every stage from source checkout to a healthy workload." actions={<><button className="button button-secondary" type="button" onClick={() => void trigger("failure")} disabled={starting}><Icon name="sparkles" size={15} /> Demo failure</button><button className="button button-primary" type="button" onClick={() => void trigger("success")} disabled={starting}><Icon name="plus" size={15} /> Run pipeline</button></>} />
      <div className="callout" style={{ marginBottom: 25 }}><Icon name="activity" size={16} /><span>Pipeline states in this prototype advance automatically. When the backend is connected, this same view will poll the GitHub workflow status and deployment worker.</span></div>
      <div className="panel panel-pad"><SectionHeading title="Run history" description={`${runs.length} runs for ${project.repo.owner}/${project.repo.name}`} action={<span className="tiny-label"><span className="live-dot" style={{ marginRight: 6 }} /> Auto-refresh enabled</span>} /><div className="filter-tabs">{filters.map((item) => <button className={filter === item.value ? "filter-tab active" : "filter-tab"} key={item.value} type="button" onClick={() => setFilter(item.value)}>{item.label}<span>{item.value === "all" ? runs.length : runs.filter((run) => run.status === item.value).length}</span></button>)}</div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Run</th><th>Commit</th><th>Trigger</th><th>Duration</th><th>Status</th><th /></tr></thead><tbody>{visibleRuns.map((run) => <tr key={run.id}><td className="primary-cell"><Link href={`/projects/${project.id}/pipelines/${run.id}`}>#{run.number}</Link></td><td><div className="cell-stack"><span className="commit-code">{run.commitSha}</span><small>{run.commitMessage}</small></div></td><td><div className="cell-stack"><strong>{run.triggerType === "push" ? "Repository push" : "Manual run"}</strong><small>{relativeTime(run.startedAt)}</small></div></td><td>{run.duration ?? (run.status === "running" ? "In progress" : "—")}</td><td><StatusPill status={run.status} /></td><td><div className="table-actions"><Link href={`/projects/${project.id}/pipelines/${run.id}`} className="icon-button" aria-label={`Open run ${run.number}`}><Icon name="chevron-right" size={15} /></Link></div></td></tr>)}</tbody></table></div>{!visibleRuns.length ? <div className="empty-inline">No runs match this filter.</div> : null}</div>
    </>
  );
}
