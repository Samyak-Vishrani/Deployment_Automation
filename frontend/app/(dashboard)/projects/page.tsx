"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePlatform } from "@/lib/platform/context";
import type { Project } from "@/lib/platform/types";
import { relativeTime } from "@/lib/format";

export default function ProjectsPage() {
  const platform = usePlatform();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    platform.listProjects().then(setProjects).finally(() => setLoading(false));
  }, [platform]);

  return (
    <>
      <PageHeader eyebrow="Workspace" title="Projects" description="Connect repositories to a delivery path that your whole team can understand." actions={<Link className="button button-primary" href="/projects/new"><Icon name="plus" size={15} /> New project</Link>} />
      {loading ? <div className="grid-2"><div className="skeleton" style={{ height: 180 }} /><div className="skeleton" style={{ height: 180 }} /></div> : projects.length ? <div className="grid-2">{projects.map((project) => <Link href={`/projects/${project.id}`} className="panel project-card" key={project.id}><div className="project-card-top"><div className="project-card-name"><span className="project-symbol"><Icon name="box" size={17} /></span><div><h3>{project.name}</h3><div className="repo-line"><Icon name="github" size={12} />{project.repo.owner}/{project.repo.name}</div></div></div><StatusPill status={project.status} /></div><p className="project-card-desc">{project.description}</p><div className="project-card-footer"><span>{project.config.environment} · port {project.config.port}</span><span>Last sync {relativeTime(project.repo.lastSyncAt)}</span></div></Link>)}</div> : <div className="panel module-placeholder"><div><div className="module-placeholder-icon"><Icon name="layers" size={20} /></div><h3>Your workspace is empty</h3><p>Connect a repository and define its first deployment environment to get started.</p><Link className="button button-primary" href="/projects/new" style={{ marginTop: 18 }}>Create first project <Icon name="arrow-up-right" size={15} /></Link></div></div>}
    </>
  );
}
