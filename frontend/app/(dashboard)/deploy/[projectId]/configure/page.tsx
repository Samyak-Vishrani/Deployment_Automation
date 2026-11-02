"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  getComponentProposal,
  getDeployProject,
  getPreflight,
  listComponents,
  saveComponents,
} from "@/lib/deploy/client";
import {
  PROVIDER_FOR_KIND,
  PROVIDER_LABEL,
  type ComponentFields,
  type ComponentKind,
  type ComponentProposal,
  type DeployComponent,
  type DeployProject,
  type PreflightCheck,
  type PreflightResult,
  type ProposedComponent,
} from "@/lib/deploy/types";

/** One card being edited. Text fields hold "" for "not set"; null is restored on save. */
type Draft = {
  key: string;
  kind: ComponentKind | null;
  name: string;
  rootDir: string;
  framework: string;
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  outputDir: string;
  nodeVersion: string;
  analysisComponentId: string | null;
  evidence: string[];
};

type TextField = "name" | "rootDir" | "framework" | "installCmd" | "buildCmd" | "startCmd" | "outputDir" | "nodeVersion";

const KIND_TONE: Record<string, string> = {
  frontend: "status-blue",
  backend: "status-green",
  database: "status-amber",
  unknown: "status-neutral",
};

const COMMAND_FIELDS: [TextField, string, string][] = [
  ["installCmd", "Install command", "npm ci"],
  ["buildCmd", "Build command", "npm run build"],
  ["startCmd", "Start command", "npm start"],
  ["outputDir", "Output folder", ".next"],
];

const CHECK_PILL: Record<PreflightCheck["status"], "passing" | "failing" | "pending"> = {
  pass: "passing",
  fail: "failing",
  pending: "pending",
};

let nextKey = 0;
const newKey = () => `draft-${nextKey++}`;

function toDraft(component: DeployComponent | ProposedComponent): Draft {
  return {
    key: "id" in component ? component.id : newKey(),
    kind: component.kind,
    name: component.name,
    rootDir: component.rootDir,
    framework: component.framework ?? "",
    installCmd: component.installCmd ?? "",
    buildCmd: component.buildCmd ?? "",
    startCmd: component.startCmd ?? "",
    outputDir: component.outputDir ?? "",
    nodeVersion: component.nodeVersion ?? "",
    analysisComponentId: component.analysisComponentId,
    evidence: "evidence" in component ? component.evidence : [],
  };
}

const orNull = (value: string) => value.trim() || null;

function toFields(draft: Draft): ComponentFields {
  const kind = draft.kind as ComponentKind;
  const database = kind === "database";
  return {
    kind,
    name: draft.name.trim(),
    rootDir: draft.rootDir.trim() || ".",
    framework: orNull(draft.framework),
    installCmd: database ? null : orNull(draft.installCmd),
    buildCmd: database ? null : orNull(draft.buildCmd),
    startCmd: database ? null : orNull(draft.startCmd),
    outputDir: database ? null : orNull(draft.outputDir),
    nodeVersion: database ? null : orNull(draft.nodeVersion),
    provider: PROVIDER_FOR_KIND[kind],
    analysisComponentId: draft.analysisComponentId,
  };
}

const emptyDraft = (kind: ComponentKind | null): Draft => ({
  key: newKey(),
  kind,
  name: kind === "database" ? "database" : "",
  rootDir: ".",
  framework: kind === "database" ? "postgres" : "",
  installCmd: "",
  buildCmd: "",
  startCmd: "",
  outputDir: "",
  nodeVersion: "",
  analysisComponentId: null,
  evidence: [],
});

/**
 * Where each part of the repository deploys: one card per component, proposed
 * from the analysis, edited and saved by the user, then checked by pre-flight.
 */
export default function ConfigureComponentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<DeployProject | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [proposal, setProposal] = useState<ComponentProposal | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [proposing, setProposing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const runPreflight = useCallback(async () => {
    setChecking(true);
    try {
      setPreflight(await getPreflight(projectId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }, [projectId]);

  const loadProposal = useCallback(async () => {
    setProposing(true);
    setError("");
    try {
      const result = await getComponentProposal(projectId);
      setProposal(result);
      setDrafts(result.components.map(toDraft));
      setPreflight(null);
      setDirty(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProposing(false);
    }
  }, [projectId]);

  const load = useCallback(async () => {
    try {
      const [projectItem, saved] = await Promise.all([
        getDeployProject(projectId),
        listComponents(projectId),
      ]);
      setProject(projectItem);
      if (saved.length > 0) {
        setDrafts(saved.map(toDraft));
        setLoading(false);
        await runPreflight();
      } else {
        setLoading(false);
        await loadProposal();
      }
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  }, [projectId, runPreflight, loadProposal]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  function edit(key: string, patch: Partial<Draft>) {
    setDrafts((current) => current.map((d) => (d.key === key ? { ...d, ...patch } : d)));
    setDirty(true);
    setPreflight(null);
  }

  function removeDraft(key: string) {
    setDrafts((current) => current.filter((d) => d.key !== key));
    setDirty(true);
    setPreflight(null);
  }

  function addDraft(kind: ComponentKind | null) {
    setDrafts((current) => [...current, emptyDraft(kind)]);
    setDirty(true);
    setPreflight(null);
  }

  const database = drafts.find((d) => d.kind === "database");

  function toggleDatabase() {
    if (database) removeDraft(database.key);
    else addDraft("database");
  }

  function onReset() {
    if (dirty && !window.confirm("Replace your edits with the components the analysis proposes?")) return;
    void loadProposal();
  }

  async function onSave() {
    const unpicked = drafts.find((d) => !d.kind);
    if (unpicked) {
      setError(`Choose whether "${unpicked.name || unpicked.rootDir}" is a frontend or a backend.`);
      return;
    }
    const unnamed = drafts.find((d) => !d.name.trim());
    if (unnamed) {
      setError("Every component needs a name.");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");
    try {
      const saved = await saveComponents(projectId, drafts.map(toFields));
      setDrafts(saved.map(toDraft));
      setProposal(null);
      setDirty(false);
      await runPreflight();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (error && !project && !loading) {
    return (
      <div className="panel module-placeholder">
        <div>
          <div className="module-placeholder-icon">
            <Icon name="layers" size={20} />
          </div>
          <h3>Project unavailable</h3>
          <p>{error}</p>
          <Link href="/deploy" className="button button-primary" style={{ marginTop: 18 }}>
            Back to deploy
          </Link>
        </div>
      </div>
    );
  }

  if (loading || !project) {
    return (
      <div className="loading-grid">
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }

  const canDeploy = Boolean(preflight?.ok) && !dirty;

  return (
    <>
      <Link href={`/deploy/${projectId}`} className="back-link">
        <Icon name="chevron-left" size={14} /> {project.name}
      </Link>
      <PageHeader
        eyebrow="Deployment configuration"
        title="Configure components"
        description={`Confirm where each part of ${project.repoFullName ?? project.name} deploys. Frontends go to Vercel, backends to Render, the database to Neon.`}
        actions={
          <>
            <button
              className="button button-secondary"
              type="button"
              onClick={onReset}
              disabled={proposing || saving}
            >
              <Icon name="refresh" size={14} /> {proposing ? "Analysing…" : "Reload from analysis"}
            </button>
            <button
              className="button button-primary"
              type="button"
              disabled={!canDeploy}
              title={
                canDeploy
                  ? "Provider deploys arrive in Phase 6"
                  : dirty
                    ? "Save first, then pre-flight runs"
                    : "Every pre-flight check has to pass. Provider deploys arrive in Phase 6."
              }
              onClick={() => setNotice("Provider deploys arrive in Phase 6.")}
            >
              <Icon name="rocket" size={15} /> Deploy
            </button>
          </>
        }
      />

      {error ? (
        <div className="form-error" style={{ marginBottom: 14 }}>
          <Icon name="x" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="callout" style={{ marginBottom: 14 }}>
          <Icon name="sparkles" size={15} />
          <span>{notice}</span>
        </div>
      ) : null}
      {proposal ? (
        <div className="callout" style={{ marginBottom: 14 }}>
          <Icon name="search" size={15} />
          <span>
            {proposal.analysisId
              ? `Proposed from the analysis of ${proposal.branch} at ${proposal.commitSha?.slice(0, 7)}. `
              : ""}
            Nothing is saved until you click Save. Re-analysing later never changes what you save here.
          </span>
        </div>
      ) : null}

      {proposing && drafts.length === 0 ? (
        <div className="panel panel-pad">
          <div className="empty-inline">Analysing the repository…</div>
        </div>
      ) : drafts.length === 0 ? (
        <div className="panel panel-pad">
          <div className="empty-inline">
            No components. The analysis found no deployable app; add one by hand below.
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {drafts.map((draft) => (
            <ComponentCard
              key={draft.key}
              draft={draft}
              onChange={(patch) => edit(draft.key, patch)}
              onRemove={() => removeDraft(draft.key)}
            />
          ))}
        </div>
      )}

      <div className="form-footer">
        <span className="form-footer-left" style={{ display: "flex", gap: 9, alignItems: "center" }}>
          <button className="button button-ghost" type="button" onClick={() => addDraft(null)}>
            <Icon name="plus" size={14} /> Add app
          </button>
          <label style={{ display: "inline-flex", gap: 7, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={Boolean(database)} onChange={toggleDatabase} />
            Add database (Neon)
          </label>
        </span>
        <div className="form-footer-actions">
          <Link className="button button-ghost" href={`/deploy/${projectId}`}>
            Cancel
          </Link>
          <button
            className="button button-primary"
            type="button"
            onClick={() => void onSave()}
            disabled={saving || proposing}
          >
            <Icon name="check" size={14} /> {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
        </div>
      </div>

      <div className="section-heading">
        <div>
          <h2>Pre-flight</h2>
          <p>Every check has to pass before the Deploy button unlocks.</p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => void runPreflight()}
          disabled={checking || dirty}
          title={dirty ? "Save first" : undefined}
        >
          <Icon name="refresh" size={14} /> {checking ? "Checking…" : "Run again"}
        </button>
      </div>
      <div className="panel panel-pad">
        {checking && !preflight ? (
          <div className="empty-inline">Checking…</div>
        ) : !preflight ? (
          <div className="empty-inline">Save the components to run the pre-flight checks.</div>
        ) : (
          <div className="review-list">
            {preflight.checks.map((check) => (
              <div className="review-row" key={check.id}>
                <span>
                  <StatusPill status={CHECK_PILL[check.status]} />
                </span>
                <strong>{check.message}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ComponentCard({
  draft,
  onChange,
  onRemove,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
}) {
  const isDatabase = draft.kind === "database";
  const provider = draft.kind ? PROVIDER_FOR_KIND[draft.kind] : null;
  const id = (field: string) => `${draft.key}-${field}`;

  return (
    <div className="panel panel-pad">
      <div className="panel-title-row">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className={`status-pill ${KIND_TONE[draft.kind ?? "unknown"]}`}>
            {draft.kind ?? "choose kind"}
          </span>
          <div>
            <h3>{draft.name || "Unnamed component"}</h3>
            <p>
              {provider ? `Deploys to ${PROVIDER_LABEL[provider]}` : "Pick frontend or backend to choose its provider"}
              {draft.evidence.length ? ` · found from ${draft.evidence.slice(0, 2).join(", ")}` : ""}
            </p>
          </div>
        </div>
        <button className="button button-danger" type="button" onClick={onRemove} aria-label={`Remove ${draft.name}`}>
          <Icon name="x" size={14} /> Remove
        </button>
      </div>

      <div className="form-grid">
        <label className="field-label" htmlFor={id("name")}>
          Name
          <input id={id("name")} value={draft.name} onChange={(e) => onChange({ name: e.target.value })} />
        </label>

        {isDatabase ? (
          <label className="field-label" htmlFor={id("provider")}>
            Provider
            <select id={id("provider")} value="neon" disabled>
              <option value="neon">Neon</option>
            </select>
          </label>
        ) : (
          <label className="field-label" htmlFor={id("kind")}>
            Kind
            <select
              id={id("kind")}
              value={draft.kind ?? ""}
              onChange={(e) => onChange({ kind: (e.target.value || null) as ComponentKind | null })}
            >
              {!draft.kind ? <option value="">Choose…</option> : null}
              <option value="frontend">Frontend</option>
              <option value="backend">Backend</option>
            </select>
          </label>
        )}

        {isDatabase ? (
          <p className="field-hint field-full">
            Provisioned on Neon in a later phase. Its DATABASE_URL is handed to the backend, so pre-flight
            does not ask you for one.
          </p>
        ) : (
          <>
            <label className="field-label" htmlFor={id("rootDir")}>
              Root folder
              <input
                id={id("rootDir")}
                value={draft.rootDir}
                onChange={(e) => onChange({ rootDir: e.target.value })}
                placeholder="."
              />
              <p className="field-hint">Relative to the repository root. &quot;.&quot; is the root itself.</p>
            </label>

            <label className="field-label" htmlFor={id("provider")}>
              Provider
              <select id={id("provider")} value={provider ?? ""} disabled>
                {provider ? <option value={provider}>{PROVIDER_LABEL[provider]}</option> : <option value="">—</option>}
              </select>
              <p className="field-hint">Fixed per kind for now.</p>
            </label>

            <label className="field-label" htmlFor={id("framework")}>
              Framework
              <input
                id={id("framework")}
                value={draft.framework}
                onChange={(e) => onChange({ framework: e.target.value })}
                placeholder="nextjs"
              />
            </label>

            <label className="field-label" htmlFor={id("nodeVersion")}>
              Node version
              <input
                id={id("nodeVersion")}
                value={draft.nodeVersion}
                onChange={(e) => onChange({ nodeVersion: e.target.value })}
                placeholder="20"
              />
            </label>

            {COMMAND_FIELDS.map(([field, label, placeholder]) => (
              <label className="field-label" htmlFor={id(field)} key={field}>
                {label}
                <input
                  id={id(field)}
                  value={draft[field]}
                  onChange={(e) => onChange({ [field]: e.target.value })}
                  placeholder={placeholder}
                  spellCheck={false}
                />
              </label>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
