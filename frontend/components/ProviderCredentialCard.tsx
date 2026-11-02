"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/StatusPill";
import { disconnectProvider, saveProviderToken, setProviderTeam } from "@/lib/deploy/client";
import type { ProviderCredential } from "@/lib/deploy/types";

const TOKEN_URL = "https://vercel.com/account/tokens";

/**
 * Connect / reconnect / disconnect a Vercel account.
 *
 * The token goes to the backend once, over the session-authenticated API, and
 * is never shown again: the backend only ever returns the account name and
 * team. The input is a password field and is cleared after every attempt.
 */
export function ProviderCredentialCard({
  credential,
  onChange,
}: {
  credential: ProviderCredential;
  onChange: (next: ProviderCredential | null) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replacing, setReplacing] = useState(false);

  const connected = credential.state === "connected";
  const showForm = !connected || replacing;

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError("");
    try {
      onChange(await saveProviderToken("vercel", token.trim()));
      setReplacing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setToken("");
      setBusy(false);
    }
  }

  async function changeTeam(teamId: string) {
    setBusy(true);
    setError("");
    try {
      onChange(await setProviderTeam("vercel", teamId === "" ? null : teamId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect Vercel? The saved token is deleted. Projects already created on Vercel are kept there; " +
          "remove them on vercel.com if you no longer want them.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await disconnectProvider("vercel");
      onChange(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setting-line" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span className="setting-line-copy">
          <strong>Vercel</strong>
          <small>
            {connected
              ? `Deploys frontends as ${credential.accountName}${credential.teamSlug ? ` in team ${credential.teamSlug}` : " (personal scope)"}.`
              : "Where frontend components deploy. Paste an access token to connect."}
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
        <p className="field-hint">{credential.message ?? "The Vercel integration service is not running."}</p>
      ) : null}
      {credential.state === "invalid" ? (
        <p className="field-hint">Vercel rejected the saved token (revoked or expired). Paste a new one.</p>
      ) : null}

      {connected && (credential.teams?.length ?? 0) > 0 ? (
        <label className="field-label" htmlFor="vercel-team">
          Team
          <select
            id="vercel-team"
            value={credential.teamId ?? ""}
            disabled={busy || credential.scopeLocked}
            onChange={(e) => void changeTeam(e.target.value)}
          >
            <option value="">Personal scope</option>
            {credential.teams!.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name} ({team.slug})
              </option>
            ))}
          </select>
          <p className="field-hint">
            {credential.scopeLocked
              ? "Fixed: Vercel projects already exist in this team."
              : "New Vercel projects are created in this team."}
          </p>
        </label>
      ) : null}

      {showForm && credential.state !== "unavailable" ? (
        <form onSubmit={(e) => void connect(e)} style={{ display: "grid", gap: 8 }}>
          <label className="field-label" htmlFor="vercel-token">
            Access token
            <input
              id="vercel-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste a Vercel access token"
            />
            <p className="field-hint">
              <a className="text-link" href={TOKEN_URL} target="_blank" rel="noreferrer">
                Create a token on Vercel <Icon name="external" size={11} />
              </a>{" "}
              with access to the team you deploy to. It is stored encrypted and never shown again.
            </p>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button button-primary" type="submit" disabled={busy || !token.trim()}>
              <Icon name="lock" size={14} /> {busy ? "Checking…" : connected ? "Replace token" : "Connect"}
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
            <Icon name="refresh" size={14} /> Replace token
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
