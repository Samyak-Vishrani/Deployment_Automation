"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { Toast } from "@/components/ui/Toast";

const resources = [
  { name: "PostgreSQL", detail: "Primary application database", version: "15.x", status: "healthy" as const, icon: "database" as const },
  { name: "Redis", detail: "Cache and job coordination", version: "7.x", status: "configured" as const, icon: "server" as const },
];

export default function DatabasesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [toast, setToast] = useState("");
  return (
    <>
      <Link href={`/projects/${projectId}`} className="back-link"><Icon name="chevron-left" size={14} /> Project workspace</Link>
      <PageHeader eyebrow="Runtime resources" title="Databases" description="See the data services attached to this project and the provisioning work still ahead." actions={<button className="button button-primary" type="button" onClick={() => setToast("Database provisioning will be enabled after the infrastructure service is connected.")}><Icon name="plus" size={15} /> Request database</button>} />
      <div className="callout" style={{ marginBottom: 25 }}><Icon name="database" size={16} /><span>Database provisioning is intentionally represented as a controlled request in this MVP. The future worker will create resources and return connection metadata without exposing credentials.</span></div>
      <div className="grid-2">{resources.map((resource) => <div className="panel panel-pad" key={resource.name}><div className="project-card-top"><div className="project-card-name"><span className="resource-icon"><Icon name={resource.icon} size={17} /></span><div><h3>{resource.name}</h3><div className="repo-line">{resource.detail}</div></div></div><StatusPill status={resource.status} /></div><div className="review-list" style={{ marginTop: 19 }}><div className="review-row"><span>Version</span><strong>{resource.version}</strong></div><div className="review-row"><span>Connection</span><strong>Stored in secret metadata</strong></div><div className="review-row"><span>Environment</span><strong>Development</strong></div></div></div>)}</div>
      <div className="section-heading"><div><h2>Provisioning roadmap</h2><p>Infrastructure actions that will become automated later.</p></div></div><div className="panel panel-pad"><div className="deployment-timeline"><div className="deployment-row"><span className="deployment-row-time">Next</span><span className="deployment-row-copy"><strong>Managed database provisioning</strong><small>Create the resource, inject metadata, and run a connectivity check.</small></span><StatusPill status="pending" /><Icon name="chevron-right" size={15} /></div><div className="deployment-row"><span className="deployment-row-time">Later</span><span className="deployment-row-copy"><strong>Schema migration step</strong><small>Run versioned migrations as part of a controlled pipeline stage.</small></span><StatusPill status="pending" /><Icon name="chevron-right" size={15} /></div></div></div>
      {toast ? <Toast title="Request queued" message={toast} /> : null}
    </>
  );
}
