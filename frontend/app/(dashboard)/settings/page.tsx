"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { ProviderCredentialCard } from "@/components/ProviderCredentialCard";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { Toast } from "@/components/ui/Toast";
import { listProviderCredentials } from "@/lib/deploy/client";
import type { ConnectableProvider, ProviderCredential } from "@/lib/deploy/types";

const tabs = [
  { label: "Workspace", icon: "layers" as const },
  { label: "Integrations", icon: "link" as const },
  { label: "Security", icon: "shield" as const },
];

const descriptions: Record<string, string> = {
  Workspace: "Workspace identity and local runtime defaults.",
  Integrations: "Accounts OrbitOps deploys with. Tokens are stored encrypted on the backend and never sent back.",
  Security: "Authentication and access boundaries for this workspace.",
};

const CONNECTABLE: ConnectableProvider[] = ["vercel", "render"];
const LABELS: Record<ConnectableProvider, string> = { vercel: "Vercel", render: "Render" };
const missing = (provider: ConnectableProvider): ProviderCredential => ({ provider, state: "missing" });

export default function SettingsPage() {
  const { session } = useAuth();
  const [activeTab, setActiveTab] = useState("Workspace");
  const [toast, setToast] = useState("");
  const [credentials, setCredentials] = useState<Partial<Record<ConnectableProvider, ProviderCredential>>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const loadCredentials = useCallback(async () => {
    try {
      const list = await listProviderCredentials();
      const next: Partial<Record<ConnectableProvider, ProviderCredential>> = {};
      for (const provider of CONNECTABLE) {
        next[provider] = list.find((c) => c.provider === provider) ?? missing(provider);
      }
      setCredentials(next);
      setLoaded(true);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "Integrations") void Promise.resolve().then(loadCredentials);
  }, [activeTab, loadCredentials]);

  return (
    <>
      <PageHeader
        eyebrow="Workspace configuration"
        title="Settings"
        description="Define the boundaries of the control plane and prepare the integrations that will power live delivery."
      />
      <div className="settings-grid">
        <div className="panel settings-nav">
          {tabs.map((tab) => (
            <button
              className={activeTab === tab.label ? "active" : ""}
              type="button"
              key={tab.label}
              onClick={() => setActiveTab(tab.label)}
            >
              <Icon name={tab.icon} size={16} />
              {tab.label}
              <Icon name="chevron-right" size={14} style={{ marginLeft: "auto" }} />
            </button>
          ))}
        </div>

        <div>
          <div className="panel settings-section">
            <h3>{activeTab}</h3>
            <p>{descriptions[activeTab]}</p>

            {activeTab === "Workspace" ? (
              <>
                <div className="setting-line">
                  <span className="setting-line-copy">
                    <strong>Workspace name</strong>
                    <small>Shown in the navigation and project handoff.</small>
                  </span>
                  <strong>OrbitOps Labs</strong>
                </div>
                <div className="setting-line">
                  <span className="setting-line-copy">
                    <strong>Default target</strong>
                    <small>Where new projects are deployed first.</small>
                  </span>
                  <span className="meta-chip">
                    <Icon name="server" size={12} /> Kind / development
                  </span>
                </div>
                <div className="setting-line">
                  <span className="setting-line-copy">
                    <strong>Signed-in operator</strong>
                    <small>The identity used for demo pipeline triggers.</small>
                  </span>
                  <span className="meta-chip">
                    <Icon name="users" size={12} /> {session?.user.email}
                  </span>
                </div>
              </>
            ) : null}

            {activeTab === "Integrations" ? (
              <>
                <div className="setting-line">
                  <span className="setting-line-copy">
                    <strong>GitHub</strong>
                    <small>
                      {session?.user.githubUsername
                        ? `Signed in as ${session.user.githubUsername}; repositories come from the GitHub App.`
                        : "Repository access through the GitHub App."}
                    </small>
                  </span>
                  {session?.user.githubConnected ? (
                    <StatusPill status="connected" />
                  ) : (
                    <StatusPill status="offline">Not connected</StatusPill>
                  )}
                </div>

                {loadError ? (
                  <div className="form-error">
                    <Icon name="x" size={14} />
                    <span>{loadError}</span>
                  </div>
                ) : loaded ? (
                  CONNECTABLE.map((provider) => (
                    <ProviderCredentialCard
                      key={provider}
                      provider={provider}
                      credential={credentials[provider] ?? missing(provider)}
                      onChange={(next) => {
                        setCredentials((current) => ({ ...current, [provider]: next ?? missing(provider) }));
                        setToast(
                          next
                            ? `${LABELS[provider]} saved (${next.accountName ?? "connected"}).`
                            : `${LABELS[provider]} disconnected.`,
                        );
                      }}
                    />
                  ))
                ) : (
                  <div className="setting-line">
                    <span className="setting-line-copy">
                      <strong>Vercel and Render</strong>
                      <small>Checking…</small>
                    </span>
                  </div>
                )}
                <div className="setting-line">
                  <span className="setting-line-copy">
                    <strong>Neon</strong>
                    <small>Postgres for the database component. Arrives in Phase 8.</small>
                  </span>
                  <StatusPill status="pending">Phase 8</StatusPill>
                </div>
                <div className="setting-line">
                  <span className="setting-line-copy">
                    <strong>AI analysis</strong>
                    <small>Summarizes failed pipeline and runtime evidence.</small>
                  </span>
                  <StatusPill status="warning">Demo mode</StatusPill>
                </div>
              </>
            ) : null}

            {activeTab === "Security" ? (
              <>
                <div className="setting-line">
                  <span className="setting-line-copy">
                    <strong>Session strategy</strong>
                    <small>Backend-issued JWT session with a protected cookie.</small>
                  </span>
                  <span className="status-pill status-green">
                    <span className="status-dot" />
                    HttpOnly
                  </span>
                </div>
                <div className="setting-line">
                  <span className="setting-line-copy">
                    <strong>Raw secret values</strong>
                    <small>Never rendered by the frontend.</small>
                  </span>
                  <span className="status-pill status-green">
                    <span className="status-dot" />
                    Hidden
                  </span>
                </div>
                <div className="setting-line">
                  <span className="setting-line-copy">
                    <strong>Audit log</strong>
                    <small>Record configuration changes and release actions.</small>
                  </span>
                  <button className="toggle" type="button" aria-label="Audit log enabled">
                    <span />
                  </button>
                </div>
              </>
            ) : null}
          </div>

          {activeTab !== "Integrations" ? (
            <div className="panel settings-section">
              <div className="callout">
                <Icon name="sparkles" size={16} />
                <span>
                  Settings are saved locally for this prototype. The API-backed version will persist workspace policy
                  in PostgreSQL and enforce it in the backend.
                </span>
              </div>
              <button
                className="button button-primary"
                type="button"
                style={{ marginTop: 16 }}
                onClick={() => setToast("Workspace settings are ready for the backend contract.")}
              >
                <Icon name="check" size={14} /> Save changes
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {toast ? <Toast title="Settings" message={toast} /> : null}
    </>
  );
}
