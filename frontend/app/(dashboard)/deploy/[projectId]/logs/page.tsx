"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { LogPane, type PaneLine } from "@/components/LogPane";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { getDeployProject, getLogsIndex, logDownloadUrl } from "@/lib/deploy/client";
import {
  pillStatus,
  PROVIDER_LABEL,
  type DeployProject,
  type LogsIndex,
  type LogsIndexDeployment,
  type ProviderId,
  type RuntimeSince,
} from "@/lib/deploy/types";
import { useAppEvents } from "@/lib/deploy/useAppEvents";
import { useBuildLogStream } from "@/lib/deploy/useBuildLogStream";
import { useRuntimeLogStream } from "@/lib/deploy/useRuntimeLogStream";
import { relativeTime } from "@/lib/format";

/** One tab: a component, or the project's local Docker deploys. */
type Tab = {
  id: string;
  label: string;
  provider: ProviderId;
  componentId: string | null;
  runtime: "available" | "not_deployed" | "unsupported" | "not_running";
  runtimeNote: string | null;
  deployments: LogsIndexDeployment[];
};

const RUNTIME_FROM: Partial<Record<ProviderId, string>> = { render: "Render", vercel: "Vercel", local_docker: "the Docker container" };

/**
 * A project's logs, one tab per component (Phase 12). A tab only ever shows
 * its own component: Vercel's and Render's logs are never mixed.
 * - Build: one deployment's stored build log (pick which).
 * - Runtime: the running app's logs, live, tailed only while you watch.
 */
export default function LogsPage() {
  return (
    <Suspense
      fallback={
        <div className="loading-grid">
          <div className="skeleton" />
        </div>
      }
    >
      <LogsView />
    </Suspense>
  );
}

function LogsView() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const [project, setProject] = useState<DeployProject | null>(null);
  const [index, setIndex] = useState<LogsIndex | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [p, i] = await Promise.all([getDeployProject(projectId), getLogsIndex(projectId)]);
      setProject(p);
      setIndex(i);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  // A new deployment of this project shows up in its tab's picker.
  useAppEvents((event) => {
    if (event?.kind === "deployment" && event.projectId === projectId) void load();
  });

  const tabs: Tab[] = useMemo(() => {
    if (!index) return [];
    const list: Tab[] = index.components.map((c) => ({
      id: c.componentId,
      label: `${c.name} · ${PROVIDER_LABEL[c.provider]}`,
      provider: c.provider,
      componentId: c.componentId,
      runtime: c.runtime,
      runtimeNote: c.runtimeNote,
      deployments: c.deployments,
    }));
    if (index.docker) {
      list.push({
        id: "docker",
        label: "Docker · local",
        provider: "local_docker",
        componentId: null,
        runtime: index.docker.runtime,
        runtimeNote: null,
        deployments: index.docker.deployments,
      });
    }
    return list;
  }, [index]);

  const tab = tabs.find((t) => t.id === search.get("c")) ?? tabs[0];
  const view = search.get("view") === "runtime" ? "runtime" : "build";
  const deploymentId = (tab && tab.deployments.find((d) => d.id === search.get("d"))?.id) ?? tab?.deployments[0]?.id ?? null;

  const setParams = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(search.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    router.replace(`/deploy/${projectId}/logs?${params}`, { scroll: false });
  };

  if (error && !index) {
    return (
      <div className="panel module-placeholder">
        <div>
          <h3>Logs unavailable</h3>
          <p>{error}</p>
          <Link href={`/deploy/${projectId}`} className="button button-primary" style={{ marginTop: 18 }}>
            Back to the project
          </Link>
        </div>
      </div>
    );
  }
  if (!index || !project) {
    return (
      <div className="loading-grid">
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }

  return (
    <>
      <Link href={`/deploy/${projectId}`} className="back-link">
        <Icon name="chevron-left" size={14} /> {project.name}
      </Link>
      <PageHeader
        eyebrow="Logs"
        title={`${project.name} logs`}
        description="Each component's logs on their own: build logs of every deployment, and the running app's logs live. Providers are never mixed."
      />

      {tabs.length === 0 ? (
        <div className="panel panel-pad">
          <div className="empty-inline">
            No components yet. <Link className="text-link" href={`/deploy/${projectId}/configure`}>Configure them</Link> and deploy to see logs.
          </div>
        </div>
      ) : (
        <>
          <div className="logs-tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tab?.id}
                className={`logs-tab${t.id === tab?.id ? " logs-tab-on" : ""}`}
                onClick={() => setParams({ c: t.id, d: null })}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab ? (
            <div className="panel panel-pad">
              <div className="logs-controls">
                <div className="logs-segment" role="group" aria-label="Build or runtime logs">
                  <button type="button" className={view === "build" ? "on" : ""} onClick={() => setParams({ view: null })}>
                    Build
                  </button>
                  <button type="button" className={view === "runtime" ? "on" : ""} onClick={() => setParams({ view: "runtime" })}>
                    Runtime
                  </button>
                </div>
                {view === "build" && tab.deployments.length > 0 ? (
                  <select
                    aria-label="Deployment"
                    value={deploymentId ?? ""}
                    onChange={(e) => setParams({ d: e.target.value })}
                  >
                    {tab.deployments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {deploymentLabel(d)}
                      </option>
                    ))}
                  </select>
                ) : null}
                {view === "build" && deploymentId ? (
                  <Link className="text-link" href={`/deploy/builds/${deploymentId}`}>
                    Open the build page <Icon name="arrow-up-right" size={11} />
                  </Link>
                ) : null}
              </div>

              {view === "build" ? (
                deploymentId ? (
                  <BuildView key={deploymentId} deploymentId={deploymentId} tab={tab} deployment={tab.deployments.find((d) => d.id === deploymentId)!} />
                ) : (
                  <div className="empty-inline">{tab.label} has not been deployed yet.</div>
                )
              ) : (
                <RuntimeView key={tab.id} projectId={projectId} tab={tab} />
              )}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function deploymentLabel(d: LogsIndexDeployment): string {
  return [
    d.releaseNumber ? `#${d.releaseNumber}` : null,
    d.status,
    d.commitSha ? d.commitSha.slice(0, 7) : null,
    d.trigger,
    relativeTime(d.queuedAt),
  ]
    .filter(Boolean)
    .join(" · ");
}

function BuildView({ deploymentId, tab, deployment }: { deploymentId: string; tab: Tab; deployment: LogsIndexDeployment }) {
  const log = useBuildLogStream(deploymentId);
  const lines: PaneLine[] = useMemo(
    () => log.entries.map((e) => ({ key: String(e.seq), at: e.at, source: e.source, stream: e.stream, text: e.text })),
    [log.entries],
  );
  const status = log.doneStatus ?? deployment.status;
  const live = status === "queued" || status === "running";
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <StatusPill status={pillStatus(status)} />
        <span className="tiny-label">{deployment.commitMessage?.split("\n")[0] ?? ""}</span>
      </div>
      {log.error ? (
        <div className="form-error" style={{ marginBottom: 10 }}>
          <Icon name="x" size={14} />
          <span>{log.error}</span>
        </div>
      ) : null}
      <LogPane
        lines={lines}
        live={live}
        label={`${tab.label} · build${live ? (log.connected ? " · streaming" : " · reconnecting…") : ""}`}
        emptyText={live ? "Waiting for output…" : "No log lines were recorded."}
        dropped={log.dropped}
        downloadHref={logDownloadUrl(deploymentId)}
      />
    </>
  );
}

function RuntimeView({ projectId, tab }: { projectId: string; tab: Tab }) {
  const [since, setSince] = useState<RuntimeSince>("15m");
  const [requests, setRequests] = useState(false);
  const [paused, setPaused] = useState(false);
  const [resumeToken, setResumeToken] = useState(0);
  const runnable = tab.runtime === "available";
  const log = useRuntimeLogStream(projectId, tab.componentId, { since, requests, enabled: runnable && !paused, resumeToken });
  const lines: PaneLine[] = useMemo(
    () =>
      log.entries.map((e) => ({
        key: e.id,
        at: e.at,
        source: e.source,
        stream: e.stream,
        level: e.level,
        text: e.text,
        request: e.request,
      })),
    [log.entries],
  );

  if (tab.runtime === "unsupported") {
    return (
      <div className="callout">
        <Icon name="database" size={15} />
        <span>
          {tab.runtimeNote ?? "This provider has no runtime log API."}{" "}
          <a className="text-link" href="https://console.neon.tech/app/projects" target="_blank" rel="noreferrer">
            Open the Neon console <Icon name="external" size={11} />
          </a>
        </span>
      </div>
    );
  }
  if (tab.runtime === "not_deployed" || tab.runtime === "not_running") {
    return (
      <div className="empty-inline">
        {tab.provider === "local_docker"
          ? "The Docker container is not running. Deploy the project first."
          : `${tab.label} is not live yet. Deploy it first; its runtime logs appear here once it runs.`}
      </div>
    );
  }

  const from = RUNTIME_FROM[tab.provider] ?? PROVIDER_LABEL[tab.provider];
  const resume = () => {
    setPaused(false);
    setResumeToken((n) => n + 1);
  };
  const live = !paused && !log.ended && !log.error;

  return (
    <>
      <div className="logs-controls">
        <span className="meta-chip">
          {live && log.connected ? <span className="live-dot" /> : null} Live from {from} · not stored by OrbitOps
        </span>
        <select aria-label="Show lines from the last" value={since} onChange={(e) => setSince(e.target.value as RuntimeSince)}>
          <option value="5m">Last 5 minutes</option>
          <option value="15m">Last 15 minutes</option>
          <option value="1h">Last hour</option>
        </select>
        {tab.provider === "render" ? (
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11 }}>
            <input type="checkbox" checked={requests} onChange={(e) => setRequests(e.target.checked)} /> Include requests
          </label>
        ) : null}
        {paused || log.ended || log.error ? (
          <button className="button button-secondary" type="button" onClick={resume}>
            <Icon name="refresh" size={13} /> Resume
          </button>
        ) : (
          <button className="button button-ghost" type="button" onClick={() => setPaused(true)}>
            Pause
          </button>
        )}
      </div>

      {log.notices.length ? <p className="logs-notices">{log.notices.at(-1)}</p> : null}
      {log.ended ? (
        <div className="callout" style={{ marginBottom: 10 }}>
          <Icon name="clock" size={15} />
          <span>{log.ended.message}</span>
        </div>
      ) : null}
      {log.error ? (
        <div className="form-error" style={{ marginBottom: 10 }}>
          <Icon name="x" size={14} />
          <span>
            {log.error.message}
            {log.error.code === "logs_service_unavailable" ? " Start it in Terminal 6: cd backend/logs && npm run dev." : ""}
          </span>
        </div>
      ) : null}

      <LogPane
        lines={lines}
        live={live}
        label={`${tab.label} · runtime${paused ? " · paused" : ""}`}
        emptyText={live ? `Waiting for ${from} to log something. Send a request to the app to see lines appear.` : "Nothing yet."}
        dropped={log.dropped}
        downloadName={`${tab.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-runtime.log`}
      />
    </>
  );
}
