"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AnalysisPanel } from "@/components/AnalysisPanel";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  deleteDeployProject,
  deployComponent,
  deployProject,
  getDeployProject,
  listComponents,
  listDeployRuns,
  rollbackProject,
} from "@/lib/deploy/client";
import {
  CAN_DEPLOY,
  duration,
  pillStatus,
  PROVIDER_LABEL,
  type ComponentStatus,
  type DeployComponent,
  type DeployProject,
  type DeployRun,
} from "@/lib/deploy/types";
import { useAppEvents } from "@/lib/deploy/useAppEvents";
import { relativeTime } from "@/lib/format";

const COMPONENT_PILL: Record<ComponentStatus, "pending" | "configured" | "deploying" | "live" | "failed"> = {
  draft: "pending",
  configured: "configured",
  deploying: "deploying",
  live: "live",
  failed: "failed",
};

export default function DeployProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const [project, setProject] = useState<DeployProject | null>(null);
  const [runs, setRuns] = useState<DeployRun[]>([]);
  const [components, setComponents] = useState<DeployComponent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [projectItem, runItems, componentItems] = await Promise.all([
        getDeployProject(projectId),
        listDeployRuns(projectId),
        listComponents(projectId),
      ]);
      setProject(projectItem);
      setRuns(runItems);
      setComponents(componentItems);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useAppEvents(load);

  async function onDeploy() {
    setBusy(true);
    try {
      const run = await deployProject(projectId);
      router.push(`/deploy/builds/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function onDeployComponent(component: DeployComponent) {
    setBusy(true);
    try {
      const run = await deployComponent(projectId, component.id);
      router.push(`/deploy/builds/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function onRollback() {
    if (!window.confirm(`Roll back to ${project?.previousImageTag}?`)) return;
    setBusy(true);
    try {
      const run = await rollbackProject(projectId);
      router.push(`/deploy/builds/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function onDelete() {
    if (
      !window.confirm(`Delete "${project?.name}"? Its container will be stopped and removed.`)
    ) {
      return;
    }
    setBusy(true);
    try {
      await deleteDeployProject(projectId);
      router.push("/deploy");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const componentNames = new Map(components.map((c) => [c.id, c.name]));
  // Components a provider is serving, frontends first: what "Open site" links to.
  const liveSites = components.filter((c) => c.url && c.provider !== "local_docker" && c.kind !== "database");
  // "Open site" for a frontend, "Open api" for a backend; the name when two of a kind are live.
  const openLabel = (component: DeployComponent) =>
    liveSites.filter((c) => c.kind === component.kind).length > 1
      ? component.name
      : component.kind === "backend"
        ? "api"
        : "site";

  if (error && !project) {
    return (
      <div className="panel module-placeholder">
        <div>
          <div className="module-placeholder-icon">
            <Icon name="rocket" size={20} />
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

  if (!project) {
    return (
      <div className="loading-grid">
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }

  return (
    <>
      <Link href="/deploy" className="back-link">
        <Icon name="chevron-left" size={14} /> Deploy
      </Link>
      <PageHeader
        eyebrow="Push to deploy"
        title={project.name}
        description={`${project.repoFullName ?? "no repository"} · ${project.branch ?? "no branch"}`}
        actions={
          <>
            <button className="button button-primary" type="button" onClick={() => void onDeploy()} disabled={busy}>
              <Icon name="rocket" size={15} /> Deploy now
            </button>
            {liveSites.map((component) => (
              <a
                key={component.id}
                className="button button-secondary"
                href={component.url!}
                target="_blank"
                rel="noreferrer"
                title={`${component.name} on ${PROVIDER_LABEL[component.provider]}`}
              >
                Open {openLabel(component)} <Icon name="external" size={13} />
              </a>
            ))}
            {/* The local Docker container, only once one has actually been deployed. */}
            {project.hostPort && project.currentImageTag ? (
              <a
                className="button button-secondary"
                href={`http://localhost:${project.hostPort}`}
                target="_blank"
                rel="noreferrer"
                title="The local Docker container"
              >
                Open :{project.hostPort} <Icon name="external" size={13} />
              </a>
            ) : null}
          </>
        }
      />

      {error ? (
        <div className="form-error" style={{ marginBottom: 14 }}>
          <Icon name="x" size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid-2">
        <div className="panel panel-pad">
          <div className="panel-title-row">
            <div>
              <h3>Configuration</h3>
              <p>What a push to this branch will build and run.</p>
            </div>
          </div>
          <div className="review-list">
            <div className="review-row">
              <span>Repository</span>
              <strong>
                {project.repoFullName ? (
                  <a
                    href={`https://github.com/${project.repoFullName}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {project.repoFullName}
                  </a>
                ) : (
                  "—"
                )}
                {project.repoId ? ` (id ${project.repoId})` : ""}
              </strong>
            </div>
            <div className="review-row">
              <span>Branch</span>
              <strong>{project.branch ?? "—"}</strong>
            </div>
            <div className="review-row">
              <span>Auto deploy</span>
              <strong>{project.autoDeploy ? "On" : "Off"}</strong>
            </div>
            <div className="review-row">
              <span>Watch paths</span>
              <strong>
                {project.watchPaths.length ? project.watchPaths.join(", ") : "Any change"}
              </strong>
            </div>
            <div className="review-row">
              <span>Dockerfile</span>
              <strong>
                {project.dockerfilePath} in {project.buildContext}
              </strong>
            </div>
            <div className="review-row">
              <span>Ports</span>
              <strong>
                container {project.containerPort} → host {project.hostPort ?? "—"}
              </strong>
            </div>
            <div className="review-row">
              <span>Environment</span>
              <strong>
                {project.envKeys.length ? project.envKeys.join(", ") : "None"}
                <br />
                <span className="tiny-label">Values are never sent to the browser.</span>
              </strong>
            </div>
          </div>
        </div>

        <div className="panel panel-pad">
          <div className="panel-title-row">
            <div>
              <h3>Images</h3>
              <p>Rollback redeploys the previous tag without rebuilding.</p>
            </div>
          </div>
          <div className="review-list">
            <div className="review-row">
              <span>Current</span>
              <strong>{project.currentImageTag ?? "None yet"}</strong>
            </div>
            <div className="review-row">
              <span>Previous</span>
              <strong>{project.previousImageTag ?? "None - nothing to roll back to"}</strong>
            </div>
            <div className="review-row">
              <span>Connected</span>
              <strong>{relativeTime(project.createdAt)}</strong>
            </div>
          </div>
          <div className="form-footer">
            <span className="form-footer-left">
              Deleting stops and removes the container, and frees its host port.
            </span>
            <div className="form-footer-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={() => void onRollback()}
                disabled={busy || !project.previousImageTag}
                title={
                  project.previousImageTag
                    ? `Redeploy ${project.previousImageTag}`
                    : "Needs two successful deployments before there is anything to roll back to"
                }
              >
                <Icon name="refresh" size={14} /> Roll back
              </button>
              <button
                className="button button-danger"
                type="button"
                onClick={() => void onDelete()}
                disabled={busy}
              >
                <Icon name="x" size={14} /> Delete
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="section-heading">
        <div>
          <h2>Components</h2>
          <p>Where each part of the repository deploys: frontends to Vercel, backends to Render, the database to Neon.</p>
        </div>
        <Link className="button button-secondary" href={`/deploy/${projectId}/configure`}>
          <Icon name="settings" size={14} /> Configure
        </Link>
      </div>
      <div className="panel panel-pad">
        {components.length === 0 ? (
          <div className="empty-inline">
            Not configured yet. Open Configure to confirm what the analysis found.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Kind</th>
                <th>Folder</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Site</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {components.map((component) => (
                <tr key={component.id}>
                  <td className="primary-cell">{component.name}</td>
                  <td>{component.kind}</td>
                  <td>
                    <code className="commit-code">
                      {component.rootDir === "." ? "/ (root)" : component.rootDir}
                    </code>
                  </td>
                  <td>{PROVIDER_LABEL[component.provider]}</td>
                  <td>
                    <StatusPill status={COMPONENT_PILL[component.status]} />
                  </td>
                  <td>
                    {component.url ? (
                      <a className="text-link" href={component.url} target="_blank" rel="noreferrer">
                        {component.url.replace(/^https?:\/\//, "")} <Icon name="external" size={11} />
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {CAN_DEPLOY.has(component.provider) && component.provider !== "local_docker" ? (
                      <button
                        className="button button-secondary"
                        type="button"
                        onClick={() => void onDeployComponent(component)}
                        disabled={busy || component.status === "deploying" || component.status === "draft"}
                        title={component.status === "draft" ? "Save it on the Configure screen first" : undefined}
                      >
                        <Icon name="rocket" size={13} /> {component.url ? "Redeploy" : "Deploy"}
                      </button>
                    ) : (
                      <span className="tiny-label">
                        {component.provider === "render" ? "Phase 7" : component.provider === "neon" ? "Phase 8" : ""}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AnalysisPanel projectId={projectId} />

      <div className="section-heading">
        <div>
          <h2>Builds</h2>
          <p>Every attempt to build and run this project, newest first.</p>
        </div>
      </div>
      <div className="panel panel-pad">
        {runs.length === 0 ? (
          <div className="empty-inline">
            No builds yet. Push to {project.branch ?? "the branch"}, or deploy manually.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Component</th>
                <th>Trigger</th>
                <th>Commit</th>
                <th>When</th>
                <th>Took</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link href={`/deploy/builds/${run.id}`}>
                      <StatusPill status={pillStatus(run.status)} />
                    </Link>
                  </td>
                  <td>
                    {run.componentId
                      ? `${componentNames.get(run.componentId) ?? "component"} · ${PROVIDER_LABEL[run.provider]}`
                      : "Docker (whole project)"}
                  </td>
                  <td>{run.trigger}</td>
                  <td>
                    {run.commitSha ? run.commitSha.slice(0, 7) : "—"}
                    <br />
                    <span className="tiny-label">{run.commitMessage?.split("\n")[0] ?? ""}</span>
                  </td>
                  <td>{relativeTime(run.queuedAt)}</td>
                  <td>{duration(run.startedAt, run.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
