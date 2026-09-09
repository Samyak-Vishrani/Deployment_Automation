"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { MetricCard } from "@/components/ui/MetricCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePlatform } from "@/lib/platform/context";
import type { PipelineRun, Project } from "@/lib/platform/types";
import { relativeTime } from "@/lib/format";

function ProjectCard({ project }: { project: Project }) {
  return (
    <Link href={`/projects/${project.id}`} className="panel project-card">
      <div className="project-card-top"><div className="project-card-name"><span className="project-symbol"><Icon name="box" size={16} /></span><div><h3>{project.name}</h3><div className="repo-line"><Icon name="github" size={12} />{project.repo.owner}/{project.repo.name}</div></div></div><StatusPill status={project.status} /></div>
      <p className="project-card-desc">{project.description}</p>
      <div className="project-card-footer"><span><Icon name="clock" size={11} /> {relativeTime(project.repo.lastSyncAt)} sync</span><span>Open project <Icon name="arrow-up-right" size={12} /></span></div>
    </Link>
  );
}

export default function DashboardPage() {
  const platform = usePlatform();
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    platform.listProjects()
      .then(async (projectItems) => {
        const runItems = (await Promise.all(projectItems.map((project) => platform.listPipelineRuns(project.id)))).flat();
        if (active) { setProjects(projectItems); setRuns(runItems); }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [platform]);

  const stats = useMemo(() => {
    const completed = runs.filter((run) => ["succeeded", "failed"].includes(run.status));
    const successful = completed.filter((run) => run.status === "succeeded").length;
    return {
      active: runs.filter((run) => run.status === "queued" || run.status === "running").length,
      successRate: completed.length ? `${Math.round((successful / completed.length) * 100)}%` : "—",
      healthy: projects.filter((project) => project.status === "healthy").length,
      deployments: projects.filter((project) => project.latestDeploymentId).length,
    };
  }, [projects, runs]);

  const recentRuns = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 5);

  if (loading) {
    return <div className="loading-grid"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>;
  }

  return (
    <>
      <PageHeader eyebrow="Workspace overview" title="Command center" description="A clear view of what is shipping, what is healthy, and where the next release needs attention." actions={<><Link className="button button-ghost" href="/projects"><Icon name="layers" size={15} /> View projects</Link><Link className="button button-primary" href="/projects/new"><Icon name="plus" size={15} /> New project</Link></>} />

      <div className="grid-4">
        <MetricCard label="Projects" value={String(projects.length).padStart(2, "0")} detail={`${stats.healthy} healthy environments`} icon="layers" tone="blue" />
        <MetricCard label="Delivery success" value={stats.successRate} detail="Across recent pipeline runs" icon="trend-up" tone="green" />
        <MetricCard label="Active releases" value={String(stats.active).padStart(2, "0")} detail="Currently moving through CI/CD" icon="activity" tone="amber" />
        <MetricCard label="Deployments" value={String(stats.deployments).padStart(2, "0")} detail="Environments with a release" icon="rocket" tone="purple" />
      </div>

      <div className="section-heading"><div><h2>Delivery overview</h2><p>The signal your team needs before the next deploy.</p></div></div>
      <div className="overview-hero">
        <div className="delivery-hero"><span className="hero-label"><span className="live-dot" /> Control plane ready</span><h2>From commit to healthy workload, in one continuous view.</h2><p>OrbitOps brings repository context, pipeline execution, deployment state, and operational evidence into one workspace. Start with a project to see the full handoff.</p><div className="hero-actions"><Link className="button button-primary" href="/projects/new">Connect a repository <Icon name="arrow-up-right" size={15} /></Link><Link className="button button-secondary" href="/projects/project-atlas">Open Atlas API <Icon name="chevron-right" size={15} /></Link></div><div className="hero-foot"><span><Icon name="shield" size={12} /> Cookie-authenticated</span><span><Icon name="server" size={12} /> Kind / development</span></div></div>
        <div className="panel release-card"><span className="release-icon"><Icon name="sparkles" size={18} /></span><h3>One release, explained</h3><p>Every pipeline result keeps its logs, health checks, and AI-assisted context together so the team can act without chasing a second tool.</p><div className="release-meta"><span>Latest platform signal</span><strong>All systems nominal</strong></div><div className="release-meta"><span>Next best action</span><strong>Connect your first repo</strong></div></div>
      </div>

      <div className="section-heading"><div><h2>Workspace projects</h2><p>Jump back into the services your team is moving today.</p></div><Link className="text-link" href="/projects">See all projects <Icon name="arrow-up-right" size={13} /></Link></div>
      {projects.length ? <div className="grid-2">{projects.slice(0, 4).map((project) => <ProjectCard key={project.id} project={project} />)}</div> : <div className="panel module-placeholder"><div><div className="module-placeholder-icon"><Icon name="layers" size={20} /></div><h3>No projects yet</h3><p>Create a project to connect a repository and start your first delivery journey.</p></div></div>}

      <div className="section-heading"><div><h2>Recent pipeline activity</h2><p>The latest changes across your workspace.</p></div><Link className="text-link" href="/projects/project-atlas/pipelines">Open pipeline view <Icon name="arrow-up-right" size={13} /></Link></div>
      <div className="panel data-table-wrap"><table className="data-table"><thead><tr><th>Run</th><th>Project</th><th>Commit</th><th>Triggered</th><th>Status</th></tr></thead><tbody>{recentRuns.map((run) => <tr key={run.id}><td className="primary-cell">#{run.number}</td><td><div className="cell-stack"><strong>{projects.find((project) => project.id === run.projectId)?.name ?? "Unknown project"}</strong><small>{run.branch}</small></div></td><td><span className="commit-code">{run.commitSha}</span></td><td>{relativeTime(run.startedAt)}</td><td><StatusPill status={run.status} /></td></tr>)}</tbody></table></div>
    </>
  );
}
