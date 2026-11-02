"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { RepositoryPicker } from "@/components/RepositoryPicker";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { analyzeProject, createDeployProject, listBranches } from "@/lib/deploy/client";
import { logAnalysis } from "@/lib/deploy/log-analysis";
import type { BranchList, GithubRepository } from "@/lib/deploy/types";

/** Matches https://github.com/owner/repository (protocol, www and .git optional). */
const GITHUB_REPO_URL =
  /^(https?:\/\/)?(www\.)?github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+(\.git)?\/?$/;

/** "KEY=value" per line -> object. Blank lines and #comments ignored. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  return out;
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export default function NewDeployProjectPage() {
  const router = useRouter();
  // "pick" lists the user's repositories; "url" is the fallback for one beyond
  // the list cap. Both end in the same POST, which checks access server-side.
  const [mode, setMode] = useState<"pick" | "url">("pick");
  const [selectedRepo, setSelectedRepo] = useState<GithubRepository | null>(null);
  const [branchList, setBranchList] = useState<BranchList | null>(null);
  const [branchError, setBranchError] = useState("");
  // The repository whose branches are wanted, so a slow answer for an earlier
  // pick cannot overwrite the list for the current one.
  const latestPick = useRef<number | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [branch, setBranch] = useState("");
  const [containerPort, setContainerPort] = useState("3000");
  const [dockerfilePath, setDockerfilePath] = useState("Dockerfile");
  const [watchPaths, setWatchPaths] = useState("");
  const [envText, setEnvText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  async function selectRepo(repo: GithubRepository) {
    latestPick.current = repo.id;
    setSelectedRepo(repo);
    setBranch(repo.defaultBranch);
    setBranchList(null);
    setBranchError("");
    setError("");
    try {
      const list = await listBranches(repo.owner, repo.name);
      if (latestPick.current === repo.id) {
        setBranchList(list);
        setBranch(list.defaultBranch);
      }
    } catch (e) {
      if (latestPick.current === repo.id) {
        setBranchError((e as Error).message);
      }
    }
  }

  function switchMode(next: "pick" | "url") {
    setMode(next);
    setBranch(next === "pick" && selectedRepo ? selectedRepo.defaultBranch : "");
    setError("");
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = mode === "pick" ? (selectedRepo ? `https://github.com/${selectedRepo.fullName}` : "") : repoUrl.trim();

    if (mode === "pick" && !selectedRepo) {
      setError("Pick a repository to connect.");
      return;
    }
    if (!GITHUB_REPO_URL.test(trimmed)) {
      setError("Enter a valid GitHub repository URL, e.g. https://github.com/owner/repository");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const project = await createDeployProject({
        repoUrl: trimmed,
        ...(name.trim() && { name: name.trim() }),
        ...(slug.trim() && { slug: slug.trim() }),
        ...(branch.trim() && { branch: branch.trim() }),
        ...(containerPort && { containerPort: Number(containerPort) }),
        ...(dockerfilePath.trim() && { dockerfilePath: dockerfilePath.trim() }),
        ...(watchPaths.trim() && { watchPaths: lines(watchPaths) }),
        ...(envText.trim() && { envVars: parseEnv(envText) }),
      });
      // Analyse straight away so the configure screen opens with its proposal.
      // A failure here is not a failed connect: the project exists, and the
      // configure screen analyses again (and shows the error) when it loads.
      setAnalyzing(true);
      console.log(`[analysis] project ${project.id} created; analysing ${project.repoFullName}…`);
      const startedAt = performance.now();
      await analyzeProject(project.id)
        .then((result) => logAnalysis("first analysis after connect", result, startedAt))
        .catch((e) => console.error("[analysis] first analysis failed:", e));
      router.push(`/deploy/${project.id}/configure`);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <>
      <Link href="/deploy" className="back-link">
        <Icon name="chevron-left" size={14} /> Deploy
      </Link>
      <PageHeader
        eyebrow="Push to deploy"
        title="Connect a repository"
        description="Pick one of your repositories the GitHub App can reach. Only the repository is required."
      />

      <form onSubmit={onSubmit} className="panel panel-pad">
        {error ? (
          <div className="form-error" style={{ marginBottom: 18 }}>
            <Icon name="x" size={14} />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="form-grid">
          {mode === "pick" ? (
            <div className="field-label field-full">
              <span className="field-label-row">
                Repository
                <button type="button" className="text-link" onClick={() => switchMode("url")}>
                  Paste a URL instead
                </button>
              </span>
              <RepositoryPicker selected={selectedRepo} onSelect={(repo) => void selectRepo(repo)} />
            </div>
          ) : (
            <label className="field-label field-full" htmlFor="repoUrl">
              <span className="field-label-row">
                Repository URL
                <button type="button" className="text-link" onClick={() => switchMode("pick")}>
                  Pick from your repositories
                </button>
              </span>
              <input
                id="repoUrl"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/owner/repository"
                autoFocus
              />
            </label>
          )}

          <label className="field-label" htmlFor="name">
            Display name
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={selectedRepo && mode === "pick" ? selectedRepo.name : "defaults to the repo name"}
            />
          </label>

          <label className="field-label" htmlFor="slug">
            Slug
            <input
              id="slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="defaults to the repo name"
            />
            <p className="field-hint">
              Lowercase, digits and dashes. Names the Docker image and container, so it has to be
              unique.
            </p>
          </label>

          <label className="field-label" htmlFor="branch">
            Branch
            {mode === "url" ? (
              <input
                id="branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="defaults to the repo default"
              />
            ) : (
              <select
                id="branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                disabled={!selectedRepo || !branchList}
              >
                {!selectedRepo ? <option value="">Pick a repository first</option> : null}
                {selectedRepo && !branchList ? <option value={branch}>{branch || "Loading…"}</option> : null}
                {branchList?.branches.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name}
                    {entry.name === branchList.defaultBranch ? " (default)" : ""}
                    {entry.protected ? " · protected" : ""}
                  </option>
                ))}
              </select>
            )}
            {branchError ? <p className="field-hint">Could not list branches: {branchError}</p> : null}
          </label>

          <label className="field-label" htmlFor="containerPort">
            Container port
            <input
              id="containerPort"
              type="number"
              value={containerPort}
              onChange={(e) => setContainerPort(e.target.value)}
            />
            <p className="field-hint">The port your app listens on inside the container.</p>
          </label>

          <label className="field-label field-full" htmlFor="dockerfilePath">
            Dockerfile path
            <input
              id="dockerfilePath"
              value={dockerfilePath}
              onChange={(e) => setDockerfilePath(e.target.value)}
            />
          </label>

          <label className="field-label field-full" htmlFor="watchPaths">
            Watch paths
            <textarea
              id="watchPaths"
              rows={3}
              value={watchPaths}
              onChange={(e) => setWatchPaths(e.target.value)}
              placeholder={"apps/api/**\nshared/**"}
            />
            <p className="field-hint">One glob per line. Leave empty to deploy on any change.</p>
          </label>

          <label className="field-label field-full" htmlFor="env">
            Environment variables
            <textarea
              id="env"
              rows={4}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={"NODE_ENV=production\nGREETING=hello"}
            />
            <p className="field-hint">
              KEY=value per line. Passed to the running container, never used as Docker build
              arguments - those are baked into the image history.
            </p>
          </label>
        </div>

        <div className="form-footer">
          <span className="form-footer-left">
            The repository is checked against GitHub before anything is saved.
          </span>
          <div className="form-footer-actions">
            <Link className="button button-ghost" href="/deploy">
              Cancel
            </Link>
            <button type="submit" className="button button-primary" disabled={saving}>
              {analyzing ? "Analysing repository…" : saving ? "Connecting…" : "Connect repository"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
