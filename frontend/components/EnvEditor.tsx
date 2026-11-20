"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { envSuggestions, putComponentEnv, putSharedEnv, revealEnv } from "@/lib/deploy/client";
import { parseDotenv, type DotenvSkip } from "@/lib/deploy/env-file";
import { isPublicKey, looksSecret, rowProblem, type EnvTarget } from "@/lib/deploy/env-rules";
import type { EnvironmentView, EnvPutEntry, EnvSuggestions, EnvVarView, SystemEnvView } from "@/lib/deploy/types";

/**
 * One row being edited. `value` null = keep the stored value (a secret is
 * never sent to the browser, so it cannot be re-sent).
 */
type Row = {
  id: string;
  key: string;
  /** The saved key, null for a new row. */
  savedKey: string | null;
  savedSecret: boolean | null;
  isSecret: boolean;
  value: string | null;
  /** The value as Show returned it; unchanged = not re-sent. */
  revealed: string | null;
};

let seq = 0;
const rowId = () => `env-${seq++}`;

const fromSaved = (v: EnvVarView): Row => ({
  id: rowId(),
  key: v.key,
  savedKey: v.key,
  savedSecret: v.isSecret,
  isSecret: v.isSecret,
  value: null,
  revealed: null,
});

export type EnvEditorProps = {
  projectId: string;
  /** null = the shared set. */
  componentId: string | null;
  /** Who the vars go to: drives the inline checks. */
  target: EnvTarget;
  label: string;
  vars: EnvVarView[];
  system?: SystemEnvView[];
  /** Saved changes the running deployment does not have yet. */
  pendingRedeploy?: boolean;
  /** Shown as "Save & redeploy" when the component has been deployed once. */
  onRedeploy?: () => Promise<void>;
  onSaved: (view: EnvironmentView) => void;
};

/**
 * Key/value editor for one scope (Phase 9). Secrets are write-only: a saved
 * secret can be replaced, never shown. A non-secret value can be shown on
 * click, and is held in this component's state only.
 */
export function EnvEditor(props: EnvEditorProps) {
  const { projectId, componentId, target, vars, system = [] } = props;
  const [rows, setRows] = useState<Row[]>(() => vars.map(fromSaved));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [skipped, setSkipped] = useState<DotenvSkip[]>([]);
  const [suggestions, setSuggestions] = useState<EnvSuggestions | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  const dirty = useMemo(() => {
    if (rows.length !== vars.length) return true;
    return rows.some((r) => r.savedKey === null || r.key !== r.savedKey || r.isSecret !== r.savedSecret || isEdited(r));
  }, [rows, vars.length]);

  // Leaving the page with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const problems = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.key, (seen.get(r.key) ?? 0) + 1);
    return new Map(
      rows.map((r) => {
        let problem = rowProblem(r.key, r.isSecret, target);
        if (!problem && (seen.get(r.key) ?? 0) > 1) problem = "Set twice.";
        if (!problem && r.value === null && (r.savedKey === null || r.key !== r.savedKey)) problem = "Enter a value.";
        if (!problem && r.value === null && r.savedSecret && !r.isSecret) problem = "Enter the value again to make it readable.";
        return [r.id, problem];
      }),
    );
  }, [rows, target]);

  const systemOverridden = new Set(rows.map((r) => r.key));
  const hasProblems = [...problems.values()].some(Boolean);

  function update(id: string, patch: Partial<Row>) {
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setError("");
  }

  function addRow(key = "", value = "", isSecret = true) {
    setRows((current) => [...current, { id: rowId(), key, savedKey: null, savedSecret: null, isSecret, value, revealed: null }]);
  }

  /** Imported rows: an existing key gets the new value, a new key a guessed secret flag. */
  function importEntries(entries: Array<{ key: string; value: string }>) {
    setRows((current) => {
      const next = current.map((r) => ({ ...r }));
      for (const { key, value } of entries) {
        const existing = next.find((r) => r.key === key);
        if (existing) {
          existing.value = value;
          existing.revealed = null;
        } else {
          const secret = target.kind === "frontend" && isPublicKey(key) ? false : looksSecret(key);
          next.push({ id: rowId(), key, savedKey: null, savedSecret: null, isSecret: secret, value, revealed: null });
        }
      }
      return next;
    });
  }

  function onPaste() {
    const { entries, skipped: skippedLines } = parseDotenv(pasteText);
    importEntries(entries);
    setSkipped(skippedLines);
    setPasteText("");
    if (skippedLines.length === 0) setPasteOpen(false);
  }

  async function onReveal(row: Row) {
    try {
      const { value } = await revealEnv(projectId, componentId, row.savedKey ?? row.key);
      update(row.id, { value, revealed: value });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onSuggestions() {
    if (!componentId) return;
    setLoadingSuggestions(true);
    setError("");
    try {
      setSuggestions(await envSuggestions(projectId, componentId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingSuggestions(false);
    }
  }

  async function save(redeploy: boolean) {
    if (hasProblems) {
      setError("Fix the highlighted rows first.");
      return;
    }
    const body: EnvPutEntry[] = rows.map((r) => {
      const sendValue = r.value !== null && (r.savedKey === null || r.key !== r.savedKey || isEdited(r) || r.savedSecret !== r.isSecret);
      return { key: r.key, isSecret: r.isSecret, ...(sendValue ? { value: r.value as string } : {}) };
    });
    setSaving(true);
    setError("");
    try {
      const view = componentId ? await putComponentEnv(projectId, componentId, body) : await putSharedEnv(projectId, body);
      const saved = componentId ? view.components.find((c) => c.componentId === componentId)?.vars ?? [] : view.shared;
      // Values leave the browser's memory once saved.
      setRows(saved.map(fromSaved));
      setSuggestions(null);
      props.onSaved(view);
      if (redeploy && props.onRedeploy) await props.onRedeploy();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const missingSuggestions = suggestions?.suggestions.filter((s) => !s.alreadySet && !rows.some((r) => r.key === s.key)) ?? [];

  return (
    <div className="env-editor">
      <div className="env-editor-head">
        <div>
          <strong>{props.label}</strong>
          {props.pendingRedeploy ? (
            <span className="status-pill status-amber" style={{ marginLeft: 8 }}>
              Env changed — redeploy to apply
            </span>
          ) : null}
        </div>
        <div className="env-editor-tools">
          <button className="button button-ghost" type="button" onClick={() => setPasteOpen((open) => !open)}>
            <Icon name="file-text" size={13} /> Paste .env
          </button>
          {componentId ? (
            <button className="button button-ghost" type="button" onClick={() => void onSuggestions()} disabled={loadingSuggestions}>
              <Icon name="search" size={13} /> {loadingSuggestions ? "Reading…" : "Add from .env.example"}
            </button>
          ) : null}
          <button className="button button-ghost" type="button" onClick={() => addRow()}>
            <Icon name="plus" size={13} /> Add variable
          </button>
        </div>
      </div>

      {pasteOpen ? (
        <div className="env-paste">
          <label className="field-label">
            Paste the contents of a .env file
            <textarea
              rows={5}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={'API_SECRET="..."\nGREETING=hello'}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          {skipped.length ? (
            <p className="field-hint">
              Skipped: {skipped.map((s) => `line ${s.line} (${s.reason})`).join("; ")}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button button-secondary" type="button" onClick={onPaste} disabled={!pasteText.trim()}>
              Add these rows
            </button>
            <span className="field-hint" style={{ alignSelf: "center" }}>
              Secrets are guessed from the names; check the 🔒 column before saving.
            </span>
          </div>
        </div>
      ) : null}

      {suggestions ? (
        <div className="env-paste">
          {!suggestions.found ? (
            <p className="field-hint">No {suggestions.path} on the branch.</p>
          ) : missingSuggestions.length === 0 ? (
            <p className="field-hint">Every key in {suggestions.path} is already set.</p>
          ) : (
            <>
              <p className="field-hint">From {suggestions.path}:</p>
              <div className="env-suggestions">
                {missingSuggestions.map((s) => (
                  <button
                    key={s.key}
                    className="button button-ghost"
                    type="button"
                    title={s.providedBySystem ? "OrbitOps sets this at deploy time; add it only to use your own value" : undefined}
                    onClick={() => addRow(s.key, s.example ?? "", target.kind === "frontend" && isPublicKey(s.key) ? false : s.looksSecret)}
                  >
                    <Icon name="plus" size={12} /> {s.key}
                    {s.providedBySystem ? " (set by OrbitOps)" : ""}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}

      {rows.length === 0 && system.length === 0 ? (
        <p className="field-hint" style={{ margin: "10px 0" }}>
          No variables.
        </p>
      ) : (
        <div className="env-rows">
          {rows.map((row) => {
            const problem = problems.get(row.id);
            const savedHidden = row.value === null && row.savedKey !== null;
            return (
              <div className={`env-row${problem ? " env-row-invalid" : ""}`} key={row.id}>
                <input
                  className="env-key"
                  aria-label="Name"
                  value={row.key}
                  onChange={(e) => update(row.id, { key: e.target.value.trim() })}
                  placeholder="NAME"
                  spellCheck={false}
                  autoComplete="off"
                />
                {savedHidden ? (
                  <div className="env-value env-value-hidden">
                    <span>{row.savedSecret ? "•••••• (set)" : "••••••"}</span>
                    {row.savedSecret ? (
                      <button className="button button-ghost" type="button" onClick={() => update(row.id, { value: "" })}>
                        Replace
                      </button>
                    ) : (
                      <button className="button button-ghost" type="button" onClick={() => void onReveal(row)}>
                        <Icon name="eye" size={12} /> Show
                      </button>
                    )}
                  </div>
                ) : (
                  <textarea
                    className="env-value"
                    aria-label={`Value of ${row.key || "the new variable"}`}
                    rows={1}
                    value={row.value ?? ""}
                    onChange={(e) => update(row.id, { value: e.target.value })}
                    placeholder={row.isSecret ? "secret value" : "value"}
                    spellCheck={false}
                    autoComplete="off"
                    data-secret={row.isSecret ? "true" : undefined}
                  />
                )}
                <label className="env-secret" title="Secret: write-only once saved, and a Sensitive variable on Vercel">
                  <input type="checkbox" checked={row.isSecret} onChange={(e) => update(row.id, { isSecret: e.target.checked })} />
                  <Icon name="lock" size={12} />
                </label>
                <button
                  className="button button-ghost"
                  type="button"
                  aria-label={`Remove ${row.key || "row"}`}
                  onClick={() => setRows((current) => current.filter((r) => r.id !== row.id))}
                >
                  <Icon name="x" size={12} />
                </button>
                {problem ? <p className="env-problem">{problem}</p> : null}
              </div>
            );
          })}
          {system.map((s) => (
            <div className="env-row env-row-system" key={`system-${s.key}`}>
              <code className="env-key">{s.key}</code>
              <span
                className="env-value env-value-hidden"
                title={
                  s.userWins
                    ? "Set at deploy time. A variable of the same name above is used instead."
                    : "Set at deploy time. It replaces a variable of the same name above."
                }
              >
                {s.source === "neon" ? `from the Neon database ${s.from}` : `the URL of the backend ${s.from}`}
                {systemOverridden.has(s.key) ? (s.userWins ? " · your value is used" : " · replaces your value") : ""}
              </span>
              <span className="field-hint">set by OrbitOps</span>
            </div>
          ))}
        </div>
      )}

      {error ? (
        <div className="form-error" style={{ marginTop: 10 }}>
          <Icon name="x" size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="env-editor-foot">
        <span className="field-hint">Saved encrypted. Applies on the next deploy.</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="button button-secondary" type="button" onClick={() => void save(false)} disabled={!dirty || saving}>
            <Icon name="check" size={13} /> {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
          {props.onRedeploy ? (
            <button
              className="button button-primary"
              type="button"
              onClick={() => void (dirty ? save(true) : props.onRedeploy?.())}
              disabled={saving || (!dirty && !props.pendingRedeploy)}
              title="Save, then deploy this component so it picks the variables up"
            >
              <Icon name="rocket" size={13} /> {dirty ? "Save & redeploy" : "Redeploy"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A value the user typed (or replaced), as opposed to one only shown. */
function isEdited(row: Row): boolean {
  return row.value !== null && row.value !== row.revealed;
}
