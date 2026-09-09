"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePlatform } from "@/lib/platform/context";
import type { Deployment, HealthCheck, Project } from "@/lib/platform/types";

const metricBars = [42, 48, 45, 57, 52, 61, 66, 59, 71, 64, 75, 81, 77, 84, 78, 91, 88, 94, 86, 93];

export default function ObservabilityPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const platform = usePlatform();
  const [project, setProject] = useState<Project | null>(null);
  const [health, setHealth] = useState<HealthCheck[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);

  useEffect(() => {
    Promise.all([platform.getProject(projectId), platform.getHealthChecks(projectId), platform.listDeployments(projectId)]).then(([projectItem, healthItems, deploymentItems]) => { setProject(projectItem); setHealth(healthItems); setDeployments(deploymentItems); });
  }, [platform, projectId]);

  const score = useMemo(() => health.length ? Math.round((health.filter((item) => item.status === "passing").length / health.length) * 100) : 0, [health]);
  if (!project) return <div className="panel module-placeholder"><div><div className="module-placeholder-icon"><Icon name="trend-up" size={20} /></div><h3>Observability workspace unavailable</h3><p>We could not find this project in the current workspace.</p><Link href="/projects" className="button button-primary" style={{ marginTop: 18 }}>Back to projects</Link></div></div>;

  return (
    <>
      <Link href={`/projects/${project.id}`} className="back-link"><Icon name="chevron-left" size={14} /> {project.name}</Link>
      <PageHeader eyebrow="Operational signals" title="Observability" description="A compact view of application health, rollout signals, and the evidence behind the current environment." actions={<button className="button button-secondary" type="button"><Icon name="refresh" size={14} /> Refresh signals</button>} />
      <div className="callout" style={{ marginBottom: 25 }}><Icon name="activity" size={16} /><span>These signals are currently seeded for the demo. The backend will later stream health checks from Kubernetes and metrics from Prometheus or OpenTelemetry.</span></div>
      <div className="observability-hero"><div className="panel panel-pad"><div className="panel-title-row"><div><h3>Environment health</h3><p>Latest checks for {project.config.environment}</p></div><StatusPill status={project.status === "healthy" ? "healthy" : "degraded"} /></div><div className="health-score"><div className="score-ring" style={{ background: `conic-gradient(var(--green) 0 ${score}%, rgba(87,114,143,.2) ${score}% 100%)` }}><span><strong>{score}%</strong><small>signal score</small></span></div><div className="score-copy"><h3>{score >= 75 ? "Runtime is in a good place" : "Runtime needs attention"}</h3><p>{score >= 75 ? "The current deployment is serving traffic with healthy readiness signals." : "One or more checks need attention before the environment can be considered healthy."}</p></div></div><div className="health-list" style={{ marginTop: 21 }}>{health.map((check) => <div className={`health-row ${check.status === "passing" ? "health-row-pass" : check.status === "warning" ? "health-row-warning" : "health-row-fail"}`} key={check.name}><span /><span className="health-row-copy"><strong>{check.name}</strong><small>{check.detail}</small></span><span className="health-latency">{check.latencyMs ? `${check.latencyMs}ms` : "—"}</span></div>)}</div></div><div className="panel panel-pad"><div className="panel-title-row"><div><h3>Request health</h3><p>Illustrative latency signal over the last 30 minutes</p></div><span className="tiny-label"><span className="live-dot" style={{ marginRight: 6 }} /> Live sample</span></div><div className="signal-chart">{metricBars.map((bar, index) => <i className={`signal-bar ${bar > 70 ? "good" : ""}`} style={{ "--bar": `${bar}%` } as CSSProperties} key={`${bar}-${index}`} />)}</div><div className="signal-labels"><span>30m ago</span><span>15m</span><span>now</span></div><div className="grid-2" style={{ marginTop: 18 }}><div className="metric-card"><div className="metric-icon metric-green"><Icon name="trend-up" size={16} /></div><div className="metric-copy"><span>Availability</span><strong>99.94%</strong><small>+0.12% this period</small></div></div><div className="metric-card"><div className="metric-icon metric-blue"><Icon name="clock" size={16} /></div><div className="metric-copy"><span>p95 latency</span><strong>184ms</strong><small>-21ms from last release</small></div></div></div></div></div>
      <div className="section-heading"><div><h2>Recent runtime events</h2><p>Release events connected to this environment.</p></div><Link className="text-link" href={`/projects/${project.id}/deployments`}>Open deployments <Icon name="arrow-up-right" size={13} /></Link></div>
      <div className="panel panel-pad"><div className="deployment-timeline">{deployments.slice(0, 4).map((deployment) => <div className="deployment-row" key={deployment.id}><span className="deployment-row-time">{new Date(deployment.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span className="deployment-row-copy"><strong>{deployment.version} rollout {deployment.status === "healthy" ? "completed" : "needs attention"}</strong><small>{deployment.commitSha} · {deployment.readyReplicas}/{deployment.replicas} replicas ready</small></span><StatusPill status={deployment.status} /><Link className="icon-button" href={`/projects/${project.id}/pipelines/${deployment.runId}`} aria-label="Open release pipeline"><Icon name="chevron-right" size={15} /></Link></div>)}</div></div>
    </>
  );
}
