"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  disconnectProvider,
  saveProviderToken,
  setProviderPreferences,
  setProviderTeam,
} from "@/lib/deploy/client";
import {
  RENDER_PLANS,
  RENDER_REGIONS,
  type ConnectableProvider,
  type ProviderCredential,
} from "@/lib/deploy/types";

/** What differs between providers on the card. */
const CONFIG: Record<
  ConnectableProvider,
  {
    title: string;
    purpose: string;
    secretLabel: string;
    secretNoun: string;
    createUrl: string;
    createLabel: string;
    scopeLabel: string;
    kept: string;
  }
> = {
  vercel: {
    title: "Vercel",
    purpose: "Where frontend components deploy. Paste an access token to connect.",
    secretLabel: "Access token",
    secretNoun: "token",
    createUrl: "https://vercel.com/account/tokens",
    createLabel: "Create a token on Vercel",
    scopeLabel: "Team",
    kept: "Projects already created on Vercel are kept there",
  },
  render: {
    title: "Render",
    purpose:
      "Where backend components deploy. Paste an API key to connect. Render builds from GitHub, so also connect " +
      "Render to GitHub (dashboard.render.com → Account Settings → Git).",
    secretLabel: "API key",
    secretNoun: "API key",
    createUrl: "https://dashboard.render.com/u/settings#api-keys",
    createLabel: "Create an API key on Render",
    scopeLabel: "Workspace",
    kept: "Services already created on Render are kept there",
  },
};

/**
 * Connect / reconnect / disconnect a provider account (Vercel or Render).
 *
 * The token or key goes to the backend once, over the session-authenticated
 * API, and is never shown again: the backend only ever returns the account
 * name and scope. The input is a password field and is cleared after every
 * attempt.
 */
export function ProviderCredentialCard({
  provider,
  credential,
  onChange,
}: {
  provider: ConnectableProvider;
  credential: ProviderCredential;
  onChange: (next: ProviderCredential | null) => void;
}) {
  const config = CONFIG[provider];
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replacing, setReplacing] = useState(false);

  const connected = credential.state === "connected";
  const showForm = !connected || replacing;

  async function run(action: () => Promise<ProviderCredential | null>) {
    setBusy(true);
    setError("");
    try {
      onChange(await action());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (!secret.trim()) return;
    const value = secret.trim();
    setSecret("");
    if (await run(() => saveProviderToken(provider, value))) setReplacing(false);
  }

  async function changeScope(id: string) {
    await run(() =>
      provider === "vercel"
        ? setProviderTeam("vercel", id === "" ? null : id)
        : setProviderPreferences("render", { ownerId: id }),
    );
  }

  async function disconnect() {
    if (
      !window.confirm(
        `Disconnect ${config.title}? The saved ${config.secretNoun} is deleted. ${config.kept}; ` +
          `remove them on ${config.title} if you no longer want them.`,
      )
    ) {
      return;
    }
    await run(async () => {
      await disconnectProvider(provider);
      return null;
    });
  }

  // Vercel scopes are teams (plus the personal scope); Render scopes are workspaces.
  const scopes =
    provider === "vercel"
      ? [{ id: "", label: "Personal scope" }, ...(credential.teams ?? []).map((t) => ({ id: t.id, label: `${t.name} (${t.slug})` }))]
      : (credential.owners ?? []).map((o) => ({ id: o.id, label: `${o.name}${o.type === "team" ? " (team)" : ""}` }));
  const scopeValue = provider === "vercel" ? (credential.teamId ?? "") : (credential.ownerId ?? "");
  const scopeName =
    provider === "vercel"
      ? credential.teamSlug
        ? ` in team ${credential.teamSlug}`
        : " (personal scope)"
      : credential.ownerName
        ? ` in workspace ${credential.ownerName}`
        : "";
  const showScopes = connected && (provider === "render" ? scopes.length > 0 : (credential.teams?.length ?? 0) > 0);

  return (
    <div className="setting-line" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span className="setting-line-copy">
          <strong>{config.title}</strong>
          <small>
            {connected
              ? `Deploys ${provider === "vercel" ? "frontends" : "backends"} as ${credential.accountName}${scopeName}.`
              : config.purpose}
          </small>
        </span>
        {credential.state === "connected" ? (
          <StatusPill status="connected" />
        ) : credential.state === "invalid" ? (
          <StatusPill status="failing">Reconnect</StatusPill>
        ) : credential.state === "unavailable" ? (
          <StatusPill status="warning">Unavailable</StatusPill>
        ) : (
          <StatusPill status="offline">Not connected</StatusPill>
        )}
      </div>

      {credential.state === "unavailable" ? (
        <p className="field-hint">{credential.message ?? `The ${config.title} integration service is not running.`}</p>
      ) : null}
      {credential.state === "invalid" ? (
        <p className="field-hint">
          {config.title} rejected the saved {config.secretNoun} (revoked or expired). Paste a new one.
        </p>
      ) : null}

      {showScopes ? (
        <label className="field-label" htmlFor={`${provider}-scope`}>
          {config.scopeLabel}
          <select
            id={`${provider}-scope`}
            value={scopeValue}
            disabled={busy || credential.scopeLocked}
            onChange={(e) => void changeScope(e.target.value)}
          >
            {scopes.map((scope) => (
              <option key={scope.id || "personal"} value={scope.id}>
                {scope.label}
              </option>
            ))}
          </select>
          <p className="field-hint">
            {credential.scopeLocked
              ? `Fixed: ${provider === "vercel" ? "Vercel projects" : "Render services"} already exist here.`
              : `New ${provider === "vercel" ? "Vercel projects" : "Render services"} are created here.`}
          </p>
        </label>
      ) : null}

      {connected && provider === "render" ? (
        <div className="form-grid">
          <label className="field-label" htmlFor="render-region">
            Region
            <select
              id="render-region"
              value={credential.region ?? "oregon"}
              disabled={busy}
              onChange={(e) => void run(() => setProviderPreferences("render", { region: e.target.value }))}
            >
              {RENDER_REGIONS.map((region) => (
                <option key={region.id} value={region.id}>
                  {region.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label" htmlFor="render-plan">
            Instance plan
            <select
              id="render-plan"
              value={credential.plan ?? "free"}
              disabled={busy}
              onChange={(e) => void run(() => setProviderPreferences("render", { plan: e.target.value }))}
            >
              {RENDER_PLANS.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.label}
                </option>
              ))}
            </select>
          </label>
          <p className="field-hint field-full">
            Used when a new Render service is created; Render fixes both once a service exists. Free instances sleep
            after 15 minutes without traffic and take about a minute to wake.
          </p>
        </div>
      ) : null}

      {showForm && credential.state !== "unavailable" ? (
        <form onSubmit={(e) => void connect(e)} style={{ display: "grid", gap: 8 }}>
          <label className="field-label" htmlFor={`${provider}-secret`}>
            {config.secretLabel}
            <input
              id={`${provider}-secret`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={`Paste a ${config.title} ${config.secretNoun}`}
            />
            <p className="field-hint">
              <a className="text-link" href={config.createUrl} target="_blank" rel="noreferrer">
                {config.createLabel} <Icon name="external" size={11} />
              </a>
              . It is stored encrypted and never shown again.
            </p>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button button-primary" type="submit" disabled={busy || !secret.trim()}>
              <Icon name="lock" size={14} /> {busy ? "Checking…" : connected ? `Replace ${config.secretNoun}` : "Connect"}
            </button>
            {replacing ? (
              <button className="button button-ghost" type="button" onClick={() => setReplacing(false)}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      {connected && !replacing ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button className="button button-secondary" type="button" onClick={() => setReplacing(true)} disabled={busy}>
            <Icon name="refresh" size={14} /> Replace {config.secretNoun}
          </button>
          <button className="button button-danger" type="button" onClick={() => void disconnect()} disabled={busy}>
            <Icon name="x" size={14} /> Disconnect
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="form-error">
          <Icon name="x" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
