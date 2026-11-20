"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { LogPane, type PaneLine } from "@/components/LogPane";
import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/StatusPill";
import { cancelDeployRun, getDeployRun, listComponents, logDownloadUrl } from "@/lib/deploy/client";
import {
  duration,
  isFinished,
  pillStatus,
  PROVIDER_LABEL,
  type DeploymentStatus,
  type DeployRun,
} from "@/lib/deploy/types";
import { useAppEvents } from "@/lib/deploy/useAppEvents";
import { useBuildLogStream } from "@/lib/deploy/useBuildLogStream";
import { relativeTime } from "@/lib/format";

export default function BuildPage() {
  const { deploymentId } = useParams<{ deploymentId: string }>();
  const [run, setRun] = useState<DeployRun | null>(null);
  const [componentName, setComponentName] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Phase 12: structured lines, resumed by seq after a reconnect.
  const log = useBuildLogStream(deploymentId);

  useEffect(() => {
    getDeployRun(deploymentId)
      .then(async (item) => {
        setRun(item);
        if (item.componentId) {
          const components = await listComponents(item.projectId).catch(() => []);
          setComponentName(components.find((c) => c.id === item.componentId)?.name ?? null);
        }
      })
      .catch((e) => setError((e as Error).message));
  }, [deploymentId]);

  // The log's done carries the final status; refresh the row for its URL and error.
  useEffect(() => {
    if (log.doneStatus) void getDeployRun(deploymentId).then(setRun).catch(() => undefined);
  }, [log.doneStatus, deploymentId]);

  const status: DeploymentStatus | null = log.doneStatus ?? run?.status ?? null;
  const lines: PaneLine[] = useMemo(
    () => log.entries.map((e) => ({ key: String(e.seq), at: e.at, source: e.source, stream: e.stream, text: e.text })),
    [log.entries],
  );
  const where = componentName ?? (run?.provider === "local_docker" ? "Docker" : null);

  // A provider deploy learns its dashboard link and URL part-way through, so
  // refetch the row when this deployment changes rather than only at the end.
  useAppEvents((event) => {
    if (event?.kind === "deployment" && event.deploymentId === deploymentId) {
      void getDeployRun(deploymentId).then(setRun).catch(() => undefined);
    }
  });

  const live = status !== null && !isFinished(status);

  return (
    <>
      <Link href={run ? `/deploy/${run.projectId}` : "/deploy"} className="back-link">
        <Icon name="chevron-left" size={14} /> {run ? "Back to project" : "Deploy"}
      </Link>

      <div className="page-header">
        <div className="run-title">
          <p className="eyebrow">
            Build{where && run ? ` · ${where} · ${PROVIDER_LABEL[run.provider]}` : ""}
          </p>
          <h1>{run?.commitMessage?.split("\n")[0] ?? "Deployment"}</h1>
          <p>
            {run
              ? `${run.branch}${run.commitSha ? ` · ${run.commitSha.slice(0, 7)}` : ""} · queued ${relativeTime(run.queuedAt)} · ${duration(run.startedAt, run.finishedAt)}`
              : "Loading…"}
          </p>
          <div className="run-title-meta">
            {status ? <StatusPill status={pillStatus(status)} /> : null}
            {live ? (
              <span className="meta-chip">
                <span className="live-dot" /> Streaming live
              </span>
            ) : null}
            {run?.trigger ? <span className="meta-chip">{run.trigger}</span> : null}
            {run && run.provider !== "local_docker" ? (
              <span className="meta-chip">
                {PROVIDER_LABEL[run.provider]}
                {run.provider === "neon" ? " · provision" : ""}
                {run.sourceMode ? ` · ${run.sourceMode === "git" ? "from GitHub" : "uploaded"}` : ""}
                {run.providerStatus && live ? ` · ${run.providerStatus}` : ""}
              </span>
            ) : null}
            {run?.releaseId ? (
              <Link className="meta-chip" href={`/deploy/${run.projectId}`} title="This deployment is one step of a Deploy all">
                Part of a Deploy all
              </Link>
            ) : null}
            {run ? (
              <Link
                className="meta-chip"
                href={`/deploy/${run.projectId}/logs?${new URLSearchParams(run.componentId ? { c: run.componentId, d: run.id } : { c: "docker", d: run.id })}`}
              >
                All logs of {where ?? "this project"}
              </Link>
            ) : null}
          </div>
        </div>
        <div className="run-actions">
          {run?.inspectorUrl ? (
            <a className="button button-secondary" href={run.inspectorUrl} target="_blank" rel="noreferrer">
              View on {PROVIDER_LABEL[run.provider]} <Icon name="external" size={13} />
            </a>
          ) : null}
          {status === "success" && run?.url && run.provider !== "neon" ? (
            <a className="button button-primary" href={run.url} target="_blank" rel="noreferrer">
              Open site <Icon name="external" size={13} />
            </a>
          ) : null}
          {live ? (
            <button
              className="button button-danger"
              type="button"
              onClick={() => {
                void cancelDeployRun(deploymentId).catch((e) => setError((e as Error).message));
              }}
            >
              <Icon name="x" size={14} /> Cancel
            </button>
          ) : null}
        </div>
      </div>

      {error || log.error ? (
        <div className="form-error" style={{ marginBottom: 14 }}>
          <Icon name="x" size={14} />
          <span>{error || log.error}</span>
        </div>
      ) : null}
      {run?.errorMessage ? (
        <div className="form-error" style={{ marginBottom: 14 }}>
          <Icon name="circle-help" size={14} />
          <span>{run.errorMessage}</span>
        </div>
      ) : null}

      <div className="panel panel-pad">
        <div className="panel-title-row">
          <div>
            <h3>Build output</h3>
            <p>
              {run?.provider === "neon"
                ? "Provisioning the Postgres database on Neon. Connection strings are never shown or logged."
                : run && run.provider !== "local_docker"
                  ? `${PROVIDER_LABEL[run.provider]}'s build output, relayed as it runs. Secrets are redacted as they stream.`
                  : "Fetch, docker build, and the container swap. Secrets are redacted as they stream."}
            </p>
          </div>
          {run?.imageTag ? <span className="tiny-label">{run.imageTag}</span> : null}
        </div>
        <LogPane
          lines={lines}
          live={live}
          label={live ? (log.connected ? "build output · streaming" : "build output · reconnecting…") : "build output"}
          emptyText={live ? "Waiting for output…" : "No log lines were recorded."}
          dropped={log.dropped}
          downloadHref={logDownloadUrl(deploymentId)}
        />
      </div>
    </>
  );
}
