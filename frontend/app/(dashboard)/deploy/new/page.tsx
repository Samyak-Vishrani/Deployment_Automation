"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { analyzeProject, createDeployProject } from "@/lib/deploy/client";
import { logAnalysis } from "@/lib/deploy/log-analysis";

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

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = repoUrl.trim();

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
      // Analyse straight away so the project page opens with its components.
      // A failure here is not a failed connect: the project exists, and the
      // project page offers the analysis again with the error in view.
      setAnalyzing(true);
      console.log(`[analysis] project ${project.id} created; analysing ${project.repoFullName}…`);
      const startedAt = performance.now();
      await analyzeProject(project.id)
        .then((result) => logAnalysis("first analysis after connect", result, startedAt))
        .catch((e) => console.error("[analysis] first analysis failed:", e));
      router.push(`/deploy/${project.id}`);
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
        description="The GitHub App must already be installed on the repository. Only the URL is required."
      />

      <form onSubmit={onSubmit} className="panel panel-pad">
        {error ? (
          <div className="form-error" style={{ marginBottom: 18 }}>
            <Icon name="x" size={14} />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="form-grid">
          <label className="field-label field-full" htmlFor="repoUrl">
            Repository URL
            <input
              id="repoUrl"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repository"
              autoFocus
            />
          </label>

          <label className="field-label" htmlFor="name">
            Display name
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="defaults to the repo name"
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
            <input
              id="branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="defaults to the repo default"
            />
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
