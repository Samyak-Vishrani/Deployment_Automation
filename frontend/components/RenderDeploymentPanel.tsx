"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { BuildLog } from "@/components/BuildLog";
import { analyzeRender, connectRender, disconnectRender, getRender, isActiveRender, parseEnvText, renderAction, renderWorkspaces, saveRender, type RenderView } from "@/lib/deploy/render";

export function RenderDeploymentPanel({ projectId }: { projectId: string }) {
  const [view, setView] = useState<RenderView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [owners, setOwners] = useState<{ id: string; name: string }[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [selected, setSelected] = useState("");
  const [runtime, setRuntime] = useState("node");
  const [region, setRegion] = useState("singapore");
  const [plan, setPlan] = useState("free");
  const [health, setHealth] = useState("");
  const [env, setEnv] = useState("");
  const [replaceEnv, setReplaceEnv] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selectedRun, setSelectedRun] = useState("");
  const requestKeys = useRef<Record<string, string>>({});
  const polling = useRef(false);
  const initialized = useRef(false);
  const refresh = useCallback(async () => {
    const result = await getRender(projectId);
    setView(result);
    if (!initialized.current && result.components.length) {
      const first = result.components[0].config;
      setRuntime(first?.runtime ?? "node"); setRegion(first?.region ?? "singapore");
      setPlan(first?.plan ?? "free"); setHealth(first?.healthCheckPath ?? "");
      initialized.current = true;
    }
  }, [projectId]);
  useEffect(() => { void Promise.resolve().then(refresh).catch(e => setError(e.message)); }, [refresh]);

  const component = view?.components.find(c => c.id === selected) ?? view?.components[0];
  const config = component?.config;
  const componentId = component?.id;
  function selectComponent(id: string) {
    const next = view?.components.find(c => c.id === id)?.config;
    setSelected(id); setSelectedRun("");
    setRuntime(next?.runtime ?? "node"); setRegion(next?.region ?? "singapore");
    setPlan(next?.plan ?? "free"); setHealth(next?.healthCheckPath ?? "");
    setEnv(""); setReplaceEnv(false); setDirty(false);
  }

  const run = view?.deployments.find(d => d.id === selectedRun) ?? view?.deployments.find(d => d.componentId === componentId);
  const active = Boolean(view?.deployments.some(d => d.componentId === componentId && isActiveRender(d.status)));
  const activeIds = view?.deployments.filter(d => isActiveRender(d.status)).map(d => d.id).join(",") ?? "";
  useEffect(() => {
    if (!activeIds || !view?.connection.connected) return;
    const timer = window.setInterval(async () => {
      if (polling.current || document.hidden) return;
      polling.current = true;
      try {
        for (const id of activeIds.split(",")) await renderAction(projectId, "sync", { deploymentId: id });
        await refresh();
      } catch (e) { setError((e as Error).message); }
      finally { polling.current = false; }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [activeIds, projectId, refresh, view?.connection.connected]);

  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!component) return;
    const result = await saveRender(projectId, { componentId: component.id, runtime, region, plan, healthCheckPath: health,
      ...(!config || replaceEnv ? { envVars: parseEnvText(env) } : {}) });
    setView(result); setEnv(""); setReplaceEnv(false); setDirty(false); setNotice("Render settings saved. Ready to deploy.");
  }
  async function deploy() {
    if (!component) return;
    const requestKey = requestKeys.current[component.id] ??= crypto.randomUUID();
    const result = await renderAction(projectId, "deploy", { componentId: component.id, requestKey });
    delete requestKeys.current[component.id];
    setSelectedRun(result.id); await refresh();
  }

  return <section className="panel panel-pad" id="render-deployment" style={{ marginBlock: 24 }}>
    <div className="panel-title-row"><div><h2>Deploy backend</h2><p>Render builds and hosts your backend. Deployment status refreshes every 15 seconds.</p></div><span className="meta-chip">Render</span></div>
    {error && <div role="alert" className="form-error">{error}</div>}
    {notice && <p role="status" className="callout">{notice}</p>}
    {!view ? <p>Loading Render…</p> : <>
      <details open={!view.connection.connected}>
        <summary>{view.connection.connected ? `Connected to ${view.connection.ownerName} — manage connection` : "1. Connect Render"}</summary>
        <p>Create an API key in <a href="https://dashboard.render.com/u/settings" target="_blank" rel="noreferrer">Render account settings</a>. For private repositories, authorize Render’s GitHub app too. Your key is encrypted and never returned to the browser.</p>
        <div className="form-grid">
          <label className="field-label"><span>Render API key</span><input type="password" autoComplete="off" value={key} onChange={e => { setKey(e.target.value); setOwners([]); setOwnerId(""); }} placeholder="rnd_…" /></label>
          <button className="button button-secondary" disabled={busy || !key.trim()} onClick={() => void act(async () => { const result = await renderWorkspaces(key.trim()); setOwners(result.owners); setOwnerId(result.owners[0]?.id ?? ""); if (!result.owners.length) throw new Error("No Render workspaces found for this key."); })}>Find workspaces</button>
          {owners.length > 0 && <><label className="field-label"><span>Workspace</span><select value={ownerId} onChange={e => setOwnerId(e.target.value)}>{owners.map(owner => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</select></label>
            <button className="button button-primary" disabled={busy || !ownerId} onClick={() => void act(async () => { await connectRender(key.trim(), ownerId); setKey(""); setOwners([]); await refresh(); })}>Connect Render</button></>}
          {view.connection.connected && <button className="button button-secondary" disabled={busy || Boolean(activeIds)} onClick={() => void act(async () => { await disconnectRender(); await refresh(); })}>Disconnect</button>}
        </div>
      </details>
      {!component ? <p>No backend component is configured. <Link href={`/deploy/${projectId}/configure`}>Configure components</Link> and save a backend first.</p> : <>
        <h3 style={{ marginTop: 24 }}>2. Backend settings</h3>
        <div className="form-grid">
          <label className="field-label"><span>Backend component</span><select disabled={busy} value={component.id} onChange={e => selectComponent(e.target.value)}>{view.components.map(c => <option key={c.id} value={c.id}>{c.name} ({c.rootDir})</option>)}</select></label>
          <label className="field-label"><span>Runtime</span><select value={runtime} disabled={busy || active || Boolean(config?.serviceId)} onChange={e => { setRuntime(e.target.value); setDirty(true); }}>{["node", "python", "go", "ruby", "rust"].map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="field-label"><span>Region</span><select value={region} disabled={busy || active || Boolean(config?.serviceId)} onChange={e => { setRegion(e.target.value); setDirty(true); }}>{["singapore", "oregon", "ohio", "virginia", "frankfurt"].map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="field-label"><span>Plan</span><select value={plan} disabled={busy || active || Boolean(config?.serviceId)} onChange={e => { setPlan(e.target.value); setDirty(true); }}><option value="free">Free (subject to Render availability)</option><option value="starter">Starter — paid</option><option value="standard">Standard — paid</option></select></label>
          <label className="field-label"><span>Health check path (optional)</span><input value={health} disabled={busy || active} onChange={e => { setHealth(e.target.value); setDirty(true); }} placeholder="/health" /></label>
        </div>
        <p>Folder: <code>{component.rootDir}</code> · Build: <code>{[component.installCmd, component.buildCmd].filter(Boolean).join(" && ") || "true"}</code> · Start: <code>{component.startCmd || "Not set"}</code>. <Link href={`/deploy/${projectId}/configure`}>Edit commands</Link></p>
        <p>Your server must listen on <code>0.0.0.0</code> and Render’s <code>PORT</code>. Supply a reachable database URL if your backend needs one. Render deployment is manual; GitHub pushes still follow your existing local Docker settings.</p>
        {config && <><p>Saved environment keys: {config.envKeys.join(", ") || "None"}. Values stay hidden.</p><label><input type="checkbox" checked={replaceEnv} disabled={busy || active} onChange={e => { setReplaceEnv(e.target.checked); setDirty(true); }} /> Replace all saved environment variables</label></>}
        {(!config || replaceEnv) && <label className="field-label"><span>Environment variables — KEY=value, one per line</span><textarea rows={5} value={env} disabled={busy || active} autoComplete="off" spellCheck={false} onChange={e => { setEnv(e.target.value); setDirty(true); }} placeholder="DATABASE_URL=…" /><small>Saving replaces the entire set. An empty set clears saved variables. Values are encrypted at rest.</small></label>}
        <div className="form-footer-actions" style={{ marginBlock: 16 }}>
          <button className="button button-secondary" disabled={busy || active || !view.connection.connected} onClick={() => void act(save)}>Save Render settings</button>
          <button className="button button-primary" disabled={busy || active || dirty || !config || !component.startCmd || !view.connection.connected} onClick={() => void act(deploy)}>{busy ? "Working…" : active ? "Deployment in progress" : "Deploy on Render"}</button>
          {config?.serviceId && <a className="button button-secondary" href={`https://dashboard.render.com/web/${encodeURIComponent(config.serviceId)}`} target="_blank" rel="noreferrer">Open Render dashboard</a>}
          {config?.url && <a className="button button-secondary" href={config.url} target="_blank" rel="noreferrer">Open backend</a>}
        </div>
        {dirty && <p>Save your settings before deploying.</p>}
        {plan !== "free" && <p>This plan incurs charges in your Render account. Deploy uses the plan shown above.</p>}
      </>}
      {view.deployments.length > 0 && <>
        <h3>3. Deployment logs and analysis</h3>
        <label className="field-label"><span>Deployment history</span><select value={run?.id ?? ""} onChange={e => setSelectedRun(e.target.value)}>{view.deployments.map(d => <option key={d.id} value={d.id}>{view.components.find(c => c.id === d.componentId)?.name} — {d.status} — {new Date(d.createdAt).toLocaleString()}</option>)}</select></label>
        {run && <>
          <p aria-live="polite">Status: <strong>{run.status}</strong></p>
          {run.error && <p role="alert" className="form-error">{run.error}</p>}
          <button className="button button-secondary" disabled={busy || !view.connection.connected} onClick={() => void act(async () => { await renderAction(projectId, "sync", { deploymentId: run.id }); await refresh(); })}>Refresh status and logs</button>
          <p>Logs cover this service during the deployment window and can include output from its previous running version.</p>
          {run.logWarning && <p>{run.logWarning}</p>}
          <BuildLog lines={run.logs ? run.logs.split("\n") : []} live={isActiveRender(run.status)} />
          {run.status === "uncertain" && <button className="button button-secondary" disabled={busy} onClick={() => {
            if (!window.confirm("First check Render and confirm no deployment is still running. Acknowledging this request does not cancel anything in Render. Continue?")) return;
            void act(async () => { await renderAction(projectId, "acknowledge", { deploymentId: run.id }); await refresh(); });
          }}>I checked Render — close unconfirmed request</button>}
          {run.status === "failed" && !run.analysis && <>
            <p>AI analysis sends the redacted log tail to Groq and suggests fixes. It does not modify code or redeploy.</p>
            <button className="button button-primary" disabled={busy || !run.logs || !view.aiAvailable} onClick={() => void act(async () => { await analyzeRender(projectId, run.id); await refresh(); })}>{busy ? "Working…" : "Analyze failure with AI"}</button>
            {!view.aiAvailable && <p>Set GROQ_API_KEY on the backend to enable AI analysis.</p>}
          </>}
          {run.analysisError && <p role="alert">{run.analysisError}</p>}
          {run.analysis && <div className="panel panel-pad" style={{ marginTop: 16 }}>
            <h3>AI failure analysis</h3><p>{run.analysis.analysis.summary}</p><p><strong>Likely cause:</strong> {run.analysis.analysis.rootCause}</p>
            <p>Severity: {run.analysis.analysis.severity} · Confidence: {Math.round(run.analysis.analysis.confidence * 100)}%</p>
            <ul>{run.analysis.analysis.evidence.map((line, i) => <li key={i}><code>{line}</code></li>)}</ul>
            {run.analysis.analysis.recommendations.map((item, i) => <div key={i}><h4>{item.title}</h4><p>{item.description}</p>{item.file && <p>File: <code>{item.file}</code></p>}{item.command && <pre style={{ whiteSpace: "pre-wrap" }}>{item.command}</pre>}</div>)}
          </div>}
        </>}
      </>}
    </>}
  </section>;
}

