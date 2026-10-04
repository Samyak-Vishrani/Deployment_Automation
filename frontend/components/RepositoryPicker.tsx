"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { githubLoginUrl } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/error";
import { listRepositories } from "@/lib/deploy/client";
import type { AppEvent, GithubRepository, RepositoryList } from "@/lib/deploy/types";
import { useAppEvents } from "@/lib/deploy/useAppEvents";
import { relativeTime } from "@/lib/format";

type Props = {
  selected: GithubRepository | null;
  onSelect: (repo: GithubRepository) => void;
};

const byRecentPush = (a: GithubRepository, b: GithubRepository) =>
  (b.pushedAt ? Date.parse(b.pushedAt) : 0) - (a.pushedAt ? Date.parse(a.pushedAt) : 0);

/**
 * The repositories the signed-in user can connect, grouped by the account the
 * GitHub App is installed on. Read live from GitHub through the backend, and
 * refetched when an installation changes - including one made in another tab.
 */
export function RepositoryPicker({ selected, onSelect }: Props) {
  const [list, setList] = useState<RepositoryList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setList(await listRepositories());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, (e as Error).message));
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  // Deployment events are frequent and say nothing about repositories; only an
  // installation change (or an unreadable event) is worth a GitHub round trip.
  useAppEvents(
    useCallback(
      (event: AppEvent | null) => {
        if (!event || event.kind === "github") {
          void load();
        }
      },
      [load],
    ),
  );

  const groups = useMemo(() => {
    if (!list) return [];
    const needle = query.trim().toLowerCase();
    return list.installations
      .map((installation) => ({
        installation,
        repositories: list.repositories
          .filter(
            (repo) =>
              repo.installationId === installation.id &&
              (!needle || repo.fullName.toLowerCase().includes(needle)),
          )
          .sort(byRecentPush),
      }))
      .filter((group) => group.repositories.length > 0 || !needle);
  }, [list, query]);

  if (error?.code === "github_reconnect_required") {
    return (
      <div className="callout">
        <Icon name="github" size={15} />
        <div>
          <p style={{ margin: 0 }}>{error.message}</p>
          <a className="button button-primary" href={githubLoginUrl("/deploy/new")} style={{ marginTop: 12 }}>
            <Icon name="github" size={14} /> Reconnect GitHub
          </a>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="form-error">
        <Icon name="x" size={14} />
        <span style={{ flex: 1 }}>{error.message}</span>
        <button type="button" className="button button-ghost" onClick={() => void load()}>
          <Icon name="refresh" size={13} /> Retry
        </button>
      </div>
    );
  }

  if (!list) {
    return (
      <div className="repo-picker">
        <div className="skeleton" style={{ height: 39 }} />
        <div className="skeleton" style={{ height: 160 }} />
      </div>
    );
  }

  if (list.installations.length === 0) {
    return (
      <div className="callout">
        <Icon name="github" size={15} />
        <div>
          <p style={{ margin: 0 }}>
            The OrbitOps GitHub App is not installed on any of your accounts yet. Install it on the
            repositories you want to deploy; GitHub brings you straight back here.
          </p>
          <a className="button button-primary" href={list.installUrl} style={{ marginTop: 12 }}>
            <Icon name="github" size={14} /> Install the GitHub App
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="repo-picker">
      <div className="field-label input-with-icon">
        <Icon name="search" size={14} />
        <input
          aria-label="Search repositories"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Inside the connect form: Enter here must filter, not submit.
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
          placeholder="Search repositories"
        />
      </div>

      {groups.length === 0 ? (
        <div className="empty-inline">No repository matches “{query}”.</div>
      ) : (
        groups.map(({ installation, repositories }) => (
          <section key={installation.id} className="repo-group">
            <div className="repo-group-head">
              <span className="tiny-label">
                {installation.account}
                {installation.accountType === "Organization" ? " · organisation" : ""}
              </span>
              <a href={installation.manageUrl} target="_blank" rel="noreferrer" className="text-link">
                {installation.repositorySelection === "selected" ? "Choose repositories" : "Configure"}{" "}
                <Icon name="external" size={10} />
              </a>
            </div>
            {repositories.length === 0 ? (
              <div className="empty-inline">The App has no repositories selected on this account.</div>
            ) : (
              <ul className="repo-list">
                {repositories.map((repo) => {
                  const isSelected = selected?.id === repo.id;
                  return (
                    <li key={repo.id} className={`repo-row${isSelected ? " selected" : ""}`}>
                      <Icon name={repo.private ? "lock" : "github"} size={13} />
                      <span className="repo-row-name">{repo.fullName}</span>
                      {repo.private ? <span className="meta-chip">Private</span> : null}
                      <span className="tiny-label repo-row-time">
                        {repo.pushedAt ? relativeTime(repo.pushedAt) : ""}
                      </span>
                      {repo.projectId ? (
                        <Link className="meta-chip" href={`/deploy/${repo.projectId}`}>
                          <Icon name="check" size={11} /> Connected
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className={`button ${isSelected ? "button-primary" : "button-secondary"}`}
                          onClick={() => onSelect(repo)}
                          aria-pressed={isSelected}
                        >
                          {isSelected ? "Selected" : "Select"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))
      )}

      <div className="repo-picker-foot">
        {/* A new tab keeps a half-filled form here; this tab picks up the new
            repositories from the `installation_repositories` webhook event. */}
        <a href={list.installUrl} target="_blank" rel="noreferrer" className="text-link">
          <Icon name="plus" size={12} /> Install on more repositories <Icon name="external" size={10} />
        </a>
        {list.truncated ? (
          <span className="tiny-label">Some accounts have more repositories than are listed — paste a URL for those.</span>
        ) : null}
      </div>
    </div>
  );
}
