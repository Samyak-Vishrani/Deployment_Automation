"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { Toast } from "@/components/ui/Toast";

const secrets = [
  { name: "GITHUB_ACTIONS_TOKEN", detail: "Repository integration · updated 2 days ago", scope: "pipeline" },
  { name: "DATABASE_URL", detail: "Runtime connection · updated 5 days ago", scope: "runtime" },
  { name: "OPENAI_API_KEY", detail: "AI analysis service · updated 8 days ago", scope: "platform" },
];

export default function SecretsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [toast, setToast] = useState("");
  return (
    <>
      <Link href={`/projects/${projectId}`} className="back-link"><Icon name="chevron-left" size={14} /> Project workspace</Link>
      <PageHeader eyebrow="Platform security" title="Secrets" description="Keep connection metadata visible while secret values stay inside the future backend secret store." actions={<button className="button button-primary" type="button" onClick={() => setToast("Secret creation will be enabled when the backend vault is connected.")}><Icon name="plus" size={15} /> Add secret</button>} />
      <div className="callout" style={{ marginBottom: 25 }}><Icon name="shield" size={16} /><span>Secret values are intentionally never rendered in the UI. This prototype only shows metadata, scope, and rotation state.</span></div>
      <div className="panel panel-pad"><div className="panel-title-row"><div><h3>Configured secrets</h3><p>Environment variables available to approved workflows</p></div><span className="tiny-label">{secrets.length} records</span></div><div className="masked-list">{secrets.map((secret) => <div className="secret-row" key={secret.name}><span className="secret-icon"><Icon name="lock" size={16} /></span><span className="secret-copy"><strong>{secret.name}</strong><small>{secret.detail}</small></span><span className="secret-value">••••••••••••</span><span className="meta-chip">{secret.scope}</span><button className="icon-button" type="button" aria-label={`Rotate ${secret.name}`} onClick={() => setToast(`${secret.name} is queued for rotation in the backend vault.`)}><Icon name="refresh" size={15} /></button></div>)}</div></div>
      <div className="section-heading"><div><h2>Access policy</h2><p>Controls that will become backend-enforced permissions.</p></div></div><div className="grid-2"><div className="panel panel-pad"><div className="setting-line" style={{ borderTop: 0, paddingTop: 0 }}><span className="setting-line-copy"><strong>Expose values to pipeline jobs</strong><small>Only approved jobs can read runtime secrets.</small></span><button className="toggle" type="button" aria-label="Expose values to pipeline jobs enabled"><span /></button></div><div className="setting-line"><span className="setting-line-copy"><strong>Audit rotations</strong><small>Keep an audit event for every secret change.</small></span><button className="toggle" type="button" aria-label="Audit rotations enabled"><span /></button></div></div><div className="panel module-placeholder"><div><div className="module-placeholder-icon"><Icon name="shield" size={20} /></div><h3>Vault integration next</h3><p>Connect a managed secret store before enabling production credentials or sharing values across environments.</p></div></div></div>
      {toast ? <Toast title="Security action noted" message={toast} /> : null}
    </>
  );
}
