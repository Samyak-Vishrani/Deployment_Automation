"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { MetricCard } from "@/components/ui/MetricCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { Toast } from "@/components/ui/Toast";
import { usePlatform } from "@/lib/platform/context";
import type { Deployment, HealthCheck, PipelineRun, Project } from "@/lib/platform/types";
import { relativeTime, shortDate } from "@/lib/format";

function HealthList({ checks }: { checks: HealthCheck[] }) {
  return <div className="health-list">{checks.map((check) => <div className={`health-row ${check.status === "passing" ? "health-row-pass" : check.status === "warning" ? "health-row-warning" : "health-row-fail"}`} key={check.name}><span /><span className="health-row-copy"><strong>{check.name}</strong><small>{check.detail}</small></span><span className="health-latency">{check.latencyMs ? `${check.latencyMs}ms` : "—"}</span></div>)}</div>;
}

export default function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const platform = usePlatform();
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [health, setHealth] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState(false);

  const load = useCallback(async () => {
    const currentProject = await platform.getProject(projectId);
    if (!currentProject) { setLoading(false); return; }
    const [runItems, deploymentItems, healthItems] = await Promise.all([platform.listPipelineRuns(projectId), platform.listDeployments(projectId), platform.getHealthChecks(projectId)]);
    setProject(currentProject); setRuns(runItems); setDeployments(deploymentItems); setHealth(healthItems); setLoading(false);
  }, [platform, projectId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(false), 3300);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const stats = useMemo(() => {
    const completed = runs.filter((run) => run.status === "succeeded" || run.status === "failed");
    return { successRate: completed.length ? `${Math.round((completed.filter((run) => run.status === "succeeded").length / completed.length) * 100)}%` : "—", latest: runs[0], currentDeployment: deployments[0] };
  }, [deployments, runs]);

  const runPipeline = async (simulation: "success" | "failure" = "success") => {
    setRunning(true);
    try {
      const run = await platform.triggerPipeline(projectId, simulation);
      setToast(true);
      router.push(`/projects/${projectId}/pipelines/${run.id}`);
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <div className="loading-grid"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>;
  if (!project) return <div className="panel module-placeholder"><div><div className="module-placeholder-icon"><Icon name="circle-help" size={20} /></div><h3>Project not found</h3><p>This project may have been removed from the demo workspace.</p><Link className="button button-primary" href="/projects" style={{ marginTop: 18 }}>Back to projects</Link></div></div>;

  return (
    <>
      <PageHeader eyebrow="Project workspace" title={project.name} description={project.description} actions={<><button className="button button-secondary" type="button" onClick={() => void runPipeline("failure")} disabled={running}><Icon name="sparkles" size={15} /> Demo failure</button><button className="button button-primary" type="button" onClick={() => void runPipeline()} disabled={running}>{running ? <><span className="button-spinner" />Starting</> : <><Icon name="rocket" size={15} /> Run pipeline</>}</button></>} />
      <div className="project-header-meta" style={{ marginTop: -16, marginBottom: 22 }}><span className="meta-chip"><Icon name="github" size={12} /> {project.repo.owner}/{project.repo.name}</span><span className="meta-chip"><Icon name="code" size={12} /> {project.repo.branch}</span><span className="meta-chip"><Icon name="globe" size={12} /> {project.config.environment}</span><StatusPill status={project.status} /></div>

      <div className="grid-4"><MetricCard label="Latest release" value={stats.currentDeployment?.version ?? "—"} detail={stats.currentDeployment ? relativeTime(stats.currentDeployment.createdAt) : "No deployment yet"} icon="rocket" tone="green" /><MetricCard label="Pipeline success" value={stats.successRate} detail="Across this project" icon="trend-up" tone="blue" /><MetricCard label="Health score" value={stats.currentDeployment ? `${stats.currentDeployment.healthScore}%` : "—"} detail={stats.currentDeployment ? `${stats.currentDeployment.readyReplicas}/${stats.currentDeployment.replicas} replicas ready` : "Awaiting first release"} icon="activity" tone="purple" /><MetricCard label="Last commit" value={stats.latest?.commitSha ?? "—"} detail={stats.latest ? stats.latest.commitMessage : "No pipeline history"} icon="code" tone="amber" /></div>

      <div className="section-heading"><div><h2>Delivery lane</h2><p>See how this project moves from source to a healthy workload.</p></div><Link className="text-link" href={`/projects/${project.id}/pipelines`}>View all pipeline runs <Icon name="arrow-up-right" size={13} /></Link></div>
      <div className="panel delivery-lane"><span className="lane-line" /><div className="lane-step"><span><Icon name="github" size={14} /></span><strong>Source</strong></div><div className="lane-step"><span><Icon name="terminal" size={14} /></span><strong>Pipeline</strong></div><div className="lane-step current"><span><Icon name="box" size={14} /></span><strong>Artifact</strong></div><div className="lane-step current"><span><Icon name="rocket" size={14} /></span><strong>Deploy</strong></div><div className="lane-step"><span><Icon name="activity" size={14} /></span><strong>Health</strong></div></div>

      <div className="section-heading"><div><h2>Project signals</h2><p>Operational context attached to the latest release.</p></div></div>
      <div className="project-layout"><div className="panel panel-pad"><div className="panel-title-row"><div><h3>Recent pipeline activity</h3><p>Latest builds and delivery decisions</p></div><Link href={`/projects/${project.id}/pipelines`} className="text-link">Open <Icon name="arrow-up-right" size={12} /></Link></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Run</th><th>Commit</th><th>When</th><th>Status</th></tr></thead><tbody>{runs.slice(0, 4).map((run) => <tr key={run.id}><td className="primary-cell"><Link href={`/projects/${project.id}/pipelines/${run.id}`}>#{run.number}</Link></td><td><div className="cell-stack"><span className="commit-code">{run.commitSha}</span><small>{run.commitMessage}</small></div></td><td>{relativeTime(run.startedAt)}</td><td><StatusPill status={run.status} /></td></tr>)}</tbody></table></div>{!runs.length ? <div className="empty-inline">No pipeline runs yet. Run the first one to create delivery history.</div> : null}</div><div className="panel panel-pad"><div className="panel-title-row"><div><h3>Environment health</h3><p>Checks from the current target</p></div><StatusPill status={project.status === "healthy" ? "passing" : project.status === "degraded" ? "warning" : "warning"} /></div><HealthList checks={health} /><Link className="button button-ghost button-full" href={`/projects/${project.id}/observability`} style={{ marginTop: 13 }}>Open observability <Icon name="arrow-up-right" size={14} /></Link></div></div>

      <div className="section-heading"><div><h2>Latest deployment</h2><p>Immutable release information for the environment.</p></div><Link className="text-link" href={`/projects/${project.id}/deployments`}>Deployment history <Icon name="arrow-up-right" size={13} /></Link></div>
      {stats.currentDeployment ? <div className="deployment-current"><span className="deployment-current-icon"><Icon name="rocket" size={20} /></span><span className="deployment-current-copy"><span>Current {stats.currentDeployment.environment} environment</span><strong>{stats.currentDeployment.version} · {stats.currentDeployment.commitSha}</strong><small>{stats.currentDeployment.image}</small><span className="replica-track">{Array.from({ length: stats.currentDeployment.replicas }).map((_, index) => <i className={index < stats.currentDeployment.readyReplicas ? "" : "off"} key={index} />)}</span></span><span><StatusPill status={stats.currentDeployment.status} /><small style={{ display: "block", marginTop: 8, color: "#719783", fontSize: 10 }}>{shortDate(stats.currentDeployment.createdAt)}</small></span></div> : <div className="panel module-placeholder"><div><div className="module-placeholder-icon"><Icon name="rocket" size={20} /></div><h3>No deployment yet</h3><p>Run the first pipeline to create an environment release and health record.</p></div></div>}
      {toast ? <Toast title="Pipeline started" message="The delivery view is following the new run in real time." /> : null}
    </>
  );
}
