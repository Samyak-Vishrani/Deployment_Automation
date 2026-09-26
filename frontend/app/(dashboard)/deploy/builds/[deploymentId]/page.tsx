"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BuildLog } from "@/components/BuildLog";
import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/StatusPill";
import { cancelDeployRun, getDeployRun, streamUrl } from "@/lib/deploy/client";
import {
  duration,
  isFinished,
  pillStatus,
  type DeploymentStatus,
  type DeployRun,
} from "@/lib/deploy/types";
import { relativeTime } from "@/lib/format";

export default function BuildPage() {
  const { deploymentId } = useParams<{ deploymentId: string }>();
  const [run, setRun] = useState<DeployRun | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getDeployRun(deploymentId)
      .then((item) => {
        setRun(item);
        setStatus(item.status);
      })
      .catch((e) => setError((e as Error).message));
  }, [deploymentId]);

  useEffect(() => {
    // The stream replays the whole log first and then tails it live, so this
    // works identically whether the build is running or long finished.
    const source = new EventSource(
      streamUrl(`/api/deployments/${deploymentId}/logs/stream`),
      { withCredentials: true },
    );

    source.addEventListener("line", (event) => {
      setLines((prev) => [...prev, (event as MessageEvent<string>).data]);
    });

    source.addEventListener("done", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as { status: string };
        setStatus(parsed.status as DeploymentStatus);
      } catch {
        /* ignore */
      }
      // Close explicitly, or EventSource reconnects for ever once the server
      // completes the stream.
      source.close();
      void getDeployRun(deploymentId).then(setRun).catch(() => undefined);
    });

    source.onerror = () => {
      // Fires on a normal server-side close too, so this is not necessarily an
      // error; closing is enough.
      source.close();
    };

    return () => source.close();
  }, [deploymentId]);

  const live = status !== null && !isFinished(status);

  return (
    <>
      <Link href={run ? `/deploy/${run.projectId}` : "/deploy"} className="back-link">
        <Icon name="chevron-left" size={14} /> {run ? "Back to project" : "Deploy"}
      </Link>

      <div className="page-header">
        <div className="run-title">
          <p className="eyebrow">Build</p>
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
          </div>
        </div>
        <div className="run-actions">
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

      {error ? (
        <div className="form-error" style={{ marginBottom: 14 }}>
          <Icon name="x" size={14} />
          <span>{error}</span>
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
            <p>Fetch, docker build, and the container swap. Secrets are redacted as they stream.</p>
          </div>
          {run?.imageTag ? <span className="tiny-label">{run.imageTag}</span> : null}
        </div>
        <BuildLog lines={lines} live={live} />
      </div>
    </>
  );
}
