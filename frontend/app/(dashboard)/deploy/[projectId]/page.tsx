"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AiAnalysisPanel } from "@/components/AiAnalysisPanel";
import { AiHistory } from "@/components/AiHistory";
import { AnalysisPanel } from "@/components/AnalysisPanel";
import { AskAiButton } from "@/components/AskAiButton";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  cancelRelease,
  deleteDeployProject,
  deployAll,
  deployComponent,
  deployProject,
  getDeployProject,
  getEnvironment,
  listComponents,
  listDeployRuns,
  listReleases,
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
  type EnvironmentView,
  type AnalysisView,
  type Release,
  type ReleaseStatus,
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

const RELEASE_PILL: Record<ReleaseStatus, "running" | "succeeded" | "failed" | "canceled"> = {
  running: "running",
  success: "succeeded",
  failed: "failed",
  cancelled: "canceled",
};

const KIND_TITLE = { database: "Database", backend: "Backend", frontend: "Frontend" } as const;

export default function DeployProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const [project, setProject] = useState<DeployProject | null>(null);
  const [runs, setRuns] = useState<DeployRun[]>([]);
  const [components, setComponents] = useState<DeployComponent[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [env, setEnv] = useState<EnvironmentView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Phase 13: the AI analysis on screen (the latest one asked for, or one reopened from the history).
  const [aiView, setAiView] = useState<AnalysisView | null>(null);

  const load = useCallback(async () => {
    try {
      const [projectItem, runItems, componentItems, releaseItems, envView] = await Promise.all([
        getDeployProject(projectId),
        listDeployRuns(projectId),
        listComponents(projectId),
        listReleases(projectId, 5).catch(() => [] as Release[]),
        getEnvironment(projectId).catch(() => null),
      ]);
      setProject(projectItem);
      setRuns(runItems);
      setComponents(componentItems);
      setReleases(releaseItems);
      setEnv(envView);
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

  async function onDeployAll() {
    setBusy(true);
    setError("");
    try {
      await deployAll(projectId);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onCancelRelease(release: Release) {
    if (!window.confirm(`Cancel release #${release.number}? Running deploys are cancelled; later steps never start.`)) return;
    setBusy(true);
    try {
      await cancelRelease(release.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
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
  const aiNames: Record<string, string> = { ...Object.fromEntries(componentNames), docker: "Docker (local)" };
  const showAi = (view: AnalysisView) => {
    setAiView(view);
    requestAnimationFrame(() => document.getElementById("ai-assistant")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const pendingEnv = new Set(env?.components.filter((c) => c.pendingRedeploy).map((c) => c.componentId) ?? []);
  const providerComponents = components.filter((c) => c.provider !== "local_docker");
  const latestRelease = releases[0] ?? null;
  const releaseRunning = latestRelease?.status === "running";
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
            <Link className="button button-secondary" href={`/deploy/${projectId}/logs`}>
              <Icon name="terminal" size={14} /> Logs
            </Link>
            <AskAiButton target={{ scope: "project", projectId }} label="Diagnose with AI" onResult={showAi} />
            {providerComponents.length > 0 ? (
              <button
                className="button button-primary"
                type="button"
                onClick={() => void onDeployAll()}
                disabled={busy || releaseRunning}
                title={
                  releaseRunning
                    ? `Release #${latestRelease!.number} is running`
                    : "Database (Neon) → backend (Render) → frontend (Vercel), at the branch head"
                }
              >
                <Icon name="rocket" size={15} /> Deploy all
              </button>
            ) : null}
            <button
              className={providerComponents.length > 0 ? "button button-secondary" : "button button-primary"}
              type="button"
              onClick={() => void onDeploy()}
              disabled={busy}
              title="Build and run the whole repository with local Docker"
            >
              <Icon name="rocket" size={15} /> {providerComponents.length > 0 ? "Docker build" : "Deploy now"}
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
                {project.envKeys.length ? `Shared: ${project.envKeys.join(", ")}` : "No shared variables"}
                {env
                  ? env.components
                      .filter((c) => c.kind !== "database")
                      .map((c) => (
                        <span key={c.componentId}>
                          <br />
                          {c.name}: {c.vars.length} env var{c.vars.length === 1 ? "" : "s"}
                          {c.receivesShared && project.envKeys.length ? " + shared" : ""}
                        </span>
                      ))
                  : null}
                <br />
                <span className="tiny-label">
                  Values are never sent to the browser.{" "}
                  <Link className="text-link" href={`/deploy/${projectId}/configure`}>
                    Edit in Configure → Environment
                  </Link>
                </span>
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
                  <td className="primary-cell">
                    {component.name}
                    <br />
                    <Link className="text-link" href={`/deploy/${projectId}/logs?c=${encodeURIComponent(component.id)}`}>
                      Logs
                    </Link>
                  </td>
                  <td>{component.kind}</td>
                  <td>
                    <code className="commit-code">
                      {component.rootDir === "." ? "/ (root)" : component.rootDir}
                    </code>
                  </td>
                  <td>{PROVIDER_LABEL[component.provider]}</td>
                  <td>
                    {component.kind === "database" && component.status === "live" ? (
                      <StatusPill status="connected" />
                    ) : (
                      <StatusPill status={COMPONENT_PILL[component.status]} />
                    )}
                    {pendingEnv.has(component.id) ? (
                      <span
                        className="status-pill status-amber"
                        style={{ marginLeft: 6 }}
                        title="Its env vars changed after its last successful deploy. Redeploy to apply them."
                      >
                        Env changed — redeploy to apply
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {component.url ? (
                      <a className="text-link" href={component.url} target="_blank" rel="noreferrer">
                        {component.kind === "database" ? "Open on Neon" : component.url.replace(/^https?:\/\//, "")}{" "}
                        <Icon name="external" size={11} />
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <AskAiButton
                      target={{ scope: "component", projectId, componentId: component.id }}
                      label="Analyze"
                      onResult={showAi}
                    />
                    {CAN_DEPLOY.has(component.provider) && component.provider !== "local_docker" ? (
                      <button
                        className="button button-secondary"
                        type="button"
                        onClick={() => void onDeployComponent(component)}
                        disabled={busy || component.status === "deploying" || component.status === "draft"}
                        title={component.status === "draft" ? "Save it on the Configure screen first" : undefined}
                      >
                        <Icon name={component.kind === "database" ? "database" : "rocket"} size={13} />{" "}
                        {component.kind === "database"
                          ? component.url
                            ? "Check"
                            : "Provision"
                          : component.url
                            ? "Redeploy"
                            : "Deploy"}
                      </button>
                    ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {latestRelease ? (
        <>
          <div className="section-heading">
            <div>
              <h2>Release #{latestRelease.number}</h2>
              <p>
                Deploy all at {latestRelease.commitSha.slice(0, 7)} on {latestRelease.branch}, {relativeTime(latestRelease.createdAt)}.
                Each step starts once the one before is live.
              </p>
            </div>
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <StatusPill status={RELEASE_PILL[latestRelease.status]} />
              {releaseRunning ? (
                <button
                  className="button button-danger"
                  type="button"
                  onClick={() => void onCancelRelease(latestRelease)}
                  disabled={busy}
                >
                  <Icon name="x" size={13} /> Cancel
                </button>
              ) : null}
            </span>
          </div>
          <div className="panel panel-pad">
            <div className="review-list">
              {latestRelease.steps.map((step, index) => (
                <div className="review-row" key={step.componentId}>
                  <span>
                    {index + 1}. {KIND_TITLE[step.kind]} · {PROVIDER_LABEL[step.provider]}
                  </span>
                  <strong style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    {step.deployment ? (
                      <Link href={`/deploy/builds/${step.deployment.id}`}>
                        <StatusPill status={pillStatus(step.deployment.status)} />
                      </Link>
                    ) : (
                      <StatusPill status="pending">
                        {latestRelease.status === "running" ? "Waiting" : "Not deployed"}
                      </StatusPill>
                    )}
                    <span>{step.componentName}</span>
                    {step.deployment?.url ? (
                      <a className="text-link" href={step.deployment.url} target="_blank" rel="noreferrer">
                        {step.kind === "database" ? "Neon console" : step.deployment.url.replace(/^https?:\/\//, "")}{" "}
                        <Icon name="external" size={11} />
                      </a>
                    ) : null}
                  </strong>
                </div>
              ))}
            </div>
            {latestRelease.errorMessage && latestRelease.status !== "success" ? (
              <div className="form-error" style={{ marginTop: 12 }}>
                <Icon name="x" size={14} />
                <span>{latestRelease.errorMessage}</span>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="section-heading" id="ai-assistant">
        <div>
          <h2>AI assistant</h2>
          <p>
            On demand: what is wrong (if anything) and the steps to fix it, for the whole project or one component.
          </p>
        </div>
        <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {project.currentImageTag || runs.length > 0 ? (
            <AskAiButton
              target={{ scope: "component", projectId, componentId: "docker" }}
              label="Analyze Docker"
              onResult={showAi}
            />
          ) : null}
          <AskAiButton target={{ scope: "project", projectId }} label="Diagnose with AI" primary onResult={showAi} />
        </span>
      </div>
      {aiView ? (
        <AiAnalysisPanel
          key={aiView.id}
          view={aiView}
          projectId={projectId}
          componentNames={aiNames}
          onClose={() => setAiView(null)}
        />
      ) : (
        <div className="panel panel-pad empty-inline">
          Nothing analysed yet. Diagnose the whole project, or Analyze one component from its row above.
        </div>
      )}
      <AiHistory projectId={projectId} componentNames={aiNames} refreshKey={aiView?.id ?? null} onOpen={showAi} />

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
