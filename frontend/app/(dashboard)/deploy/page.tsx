"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { listDeployProjects, listDeployRuns } from "@/lib/deploy/client";
import { pillStatus, type DeployProject, type DeployRun } from "@/lib/deploy/types";
import { useAppEvents } from "@/lib/deploy/useAppEvents";
import { relativeTime } from "@/lib/format";

export default function DeployProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<DeployProject[] | null>(null);
  const [latest, setLatest] = useState<Record<string, DeployRun | undefined>>({});
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await listDeployProjects();
      setProjects(list);
      setError("");

      // The list endpoint does not embed the latest deployment, so fetch them
      // alongside. Fine at this scale; if the list ever grows this wants to
      // become one endpoint rather than N+1 requests.
      const entries = await Promise.all(
        list.map(async (project) => {
          try {
            const runs = await listDeployRuns(project.id);
            return [project.id, runs[0]] as const;
          } catch {
            return [project.id, undefined] as const;
          }
        }),
      );
      setLatest(Object.fromEntries(entries));
    } catch (e) {
      setError((e as Error).message);
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  // Live updates instead of polling: a build triggered by a git push appears
  // the moment it is queued, and an idle page makes no requests at all.
  useAppEvents(load);

  return (
    <>
      <PageHeader
        eyebrow="Push to deploy"
        title="Deploy"
        description="Repositories wired to this platform. A push to a project's branch builds it and replaces its container."
        actions={
          <Link className="button button-primary" href="/deploy/new">
            <Icon name="plus" size={15} /> Connect repository
          </Link>
        }
      />

      {error ? (
        <div className="form-error" style={{ marginBottom: 14 }}>
          <Icon name="x" size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      {projects === null ? (
        <div className="grid-2">
          <div className="skeleton" style={{ height: 150 }} />
          <div className="skeleton" style={{ height: 150 }} />
        </div>
      ) : projects.length === 0 && !error ? (
        <div className="panel module-placeholder">
          <div>
            <div className="module-placeholder-icon">
              <Icon name="rocket" size={20} />
            </div>
            <h3>No repositories connected</h3>
            <p>
              Pick one of your GitHub repositories to get a build on every push. If the GitHub App
              is not on it yet, you can install it from the same screen.
            </p>
            <Link className="button button-primary" href="/deploy/new" style={{ marginTop: 18 }}>
              Connect repository <Icon name="arrow-up-right" size={15} />
            </Link>
          </div>
        </div>
      ) : (
        <div className="panel panel-pad">
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Repository</th>
                <th>Running on</th>
                <th>Last build</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const last = latest[project.id];
                return (
                  <tr
                    key={project.id}
                    className="row-link"
                    // The whole row opens the project. Clicks on the links
                    // inside it (build badge, port) keep their own target.
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest("a")) {
                        router.push(`/deploy/${project.id}`);
                      }
                    }}
                  >
                    <td>
                      <Link href={`/deploy/${project.id}`} className="row-link-title">
                        {project.name}
                      </Link>
                      {!project.autoDeploy ? (
                        <>
                          <br />
                          <span className="tiny-label">auto-deploy off</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {project.repoFullName ?? "—"}
                      <br />
                      <span className="tiny-label">{project.branch ?? "no branch"}</span>
                    </td>
                    <td>
                      {project.hostPort ? (
                        <a
                          href={`http://localhost:${project.hostPort}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          :{project.hostPort} <Icon name="external" size={11} />
                        </a>
                      ) : (
                        <span className="tiny-label">not allocated</span>
                      )}
                    </td>
                    <td>
                      {last ? (
                        <>
                          <Link href={`/deploy/builds/${last.id}`}>
                            <StatusPill status={pillStatus(last.status)} />
                          </Link>
                          <br />
                          <span className="tiny-label">{relativeTime(last.queuedAt)}</span>
                        </>
                      ) : (
                        <span className="tiny-label">never</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
