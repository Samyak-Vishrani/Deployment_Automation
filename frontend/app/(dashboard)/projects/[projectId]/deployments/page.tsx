"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LogViewer } from "@/components/LogViewer";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { Toast } from "@/components/ui/Toast";
import { usePlatform } from "@/lib/platform/context";
import type { Deployment, LogEntry, Project } from "@/lib/platform/types";
import { relativeTime } from "@/lib/format";

export default function DeploymentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const platform = usePlatform();
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busyId, setBusyId] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const projectItem = await platform.getProject(projectId);
    if (!projectItem) return;
    const deploymentItems = await platform.listDeployments(projectId);
    setProject(projectItem); setDeployments(deploymentItems);
    if (deploymentItems[0]) setLogs(await platform.getDeploymentLogs(deploymentItems[0].id));
  }, [platform, projectId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(""), 3200); return () => window.clearTimeout(timer); }, [toast]);

  const current = useMemo(() => deployments[0], [deployments]);
  const redeploy = async (deployment: Deployment) => {
    setBusyId(deployment.id);
    try { await platform.redeploy(deployment.id); await load(); setToast(`${deployment.version} redeployed successfully`); } finally { setBusyId(""); }
  };

  if (!project) return <div className="panel module-placeholder"><div><div className="module-placeholder-icon"><Icon name="rocket" size={20} /></div><h3>Deployment workspace unavailable</h3><p>We could not find this project in the current workspace.</p><Link href="/projects" className="button button-primary" style={{ marginTop: 18 }}>Back to projects</Link></div></div>;

  return (
    <>
      <Link href={`/projects/${project.id}`} className="back-link"><Icon name="chevron-left" size={14} /> {project.name}</Link>
      <PageHeader eyebrow="Runtime delivery" title="Deployments" description="Track immutable releases as they move into each project environment." actions={<Link className="button button-primary" href={`/projects/${project.id}/pipelines`}><Icon name="terminal" size={15} /> Open pipelines</Link>} />
      {current ? <div className="deployment-current"><span className="deployment-current-icon"><Icon name="rocket" size={20} /></span><span className="deployment-current-copy"><span>Current {current.environment} environment</span><strong>{current.version} · {current.commitSha}</strong><small>{current.image}</small><span className="replica-track">{Array.from({ length: current.replicas }).map((_, index) => <i className={index < current.readyReplicas ? "" : "off"} key={index} />)}</span></span><span><StatusPill status={current.status} /><a href={current.url} target="_blank" rel="noreferrer" className="deployment-url" style={{ display: "flex", marginTop: 10 }}>{current.url} <Icon name="external" size={11} /></a></span></div> : <div className="panel module-placeholder"><div><div className="module-placeholder-icon"><Icon name="rocket" size={20} /></div><h3>No deployments yet</h3><p>Run a pipeline to create the first release for this environment.</p></div></div>}

      {current ? <><div className="section-heading"><div><h2>Deployment record</h2><p>Rollout evidence for the current release.</p></div><button className="button button-secondary" type="button" onClick={() => void redeploy(current)} disabled={busyId === current.id}><Icon name="refresh" size={14} /> {busyId === current.id ? "Redeploying" : "Redeploy current"}</button></div><div className="grid-2"><div className="panel panel-pad"><div className="panel-title-row"><div><h3>Release details</h3><p>Immutable artifact and rollout metadata</p></div><StatusPill status={current.status} /></div><div className="review-list"><div className="review-row"><span>Version</span><strong>{current.version}</strong></div><div className="review-row"><span>Image</span><strong>{current.image}</strong></div><div className="review-row"><span>Commit</span><strong>{current.commitSha}</strong></div><div className="review-row"><span>Replicas</span><strong>{current.readyReplicas} / {current.replicas} ready</strong></div><div className="review-row"><span>Created</span><strong>{relativeTime(current.createdAt)}</strong></div></div></div><div className="panel panel-pad"><div className="panel-title-row"><div><h3>Release output</h3><p>Logs from the deployment workflow</p></div><span className="tiny-label">{logs.length} lines</span></div><LogViewer logs={logs} /></div></div></> : null}

      <div className="section-heading"><div><h2>Deployment history</h2><p>Every release remains tied to its pipeline run and commit.</p></div></div>
      <div className="panel panel-pad"><div className="deployment-timeline">{deployments.map((deployment) => <div className="deployment-row" key={deployment.id}><span className="deployment-row-time">{relativeTime(deployment.createdAt)}</span><span className="deployment-row-copy"><strong>{deployment.version} · {deployment.commitSha}</strong><small>{deployment.environment} · {deployment.image}</small></span><span><StatusPill status={deployment.status} /></span><Link className="icon-button" href={`/projects/${project.id}/pipelines/${deployment.runId}`} aria-label={`Open pipeline for ${deployment.version}`}><Icon name="chevron-right" size={15} /></Link></div>)}</div>{!deployments.length ? <div className="empty-inline">Deployment history will appear after the first successful pipeline.</div> : null}</div>
      {toast ? <Toast title="Deployment updated" message={toast} /> : null}
    </>
  );
}
