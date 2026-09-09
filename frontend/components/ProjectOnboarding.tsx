"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePlatform } from "@/lib/platform/context";
import type { ProjectInput } from "@/lib/platform/types";
import { Icon } from "./ui/Icon";

const steps = ["Project details", "Repository", "Deployment", "Review"];

const initialForm: ProjectInput = {
  name: "",
  slug: "",
  description: "",
  repoUrl: "https://github.com/",
  branch: "main",
  environment: "development",
  port: 3000,
  healthPath: "/health",
  buildPreset: "nextjs",
};

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42);
}

function repositoryParts(value: string) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname !== "github.com" || parts.length < 2) return null;
    return { owner: parts[0], name: parts[1].replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

export function ProjectOnboarding() {
  const router = useRouter();
  const platform = usePlatform();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<ProjectInput>(initialForm);
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const repo = useMemo(() => repositoryParts(form.repoUrl), [form.repoUrl]);

  const update = <K extends keyof ProjectInput>(key: K, value: ProjectInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const updateName = (value: string) => {
    setForm((current) => ({ ...current, name: value, slug: slugTouched ? current.slug : slugify(value) }));
  };

  const validateStep = () => {
    if (step === 0 && (!form.name.trim() || !form.slug.trim())) return "Add a project name and a URL-safe slug.";
    if (step === 1 && (!repo || !form.branch.trim())) return "Enter a valid GitHub repository URL and branch.";
    if (step === 2 && (form.port < 1 || form.port > 65535 || !form.healthPath.startsWith("/"))) return "Use a valid port and a health path beginning with /.";
    return "";
  };

  const next = () => {
    const validationError = validateStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    setStep((current) => Math.min(3, current + 1));
  };

  const create = async () => {
    const validationError = validateStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setCreating(true);
    setError("");
    try {
      const project = await platform.createProject(form);
      router.push(`/projects/${project.id}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create the project.");
      setCreating(false);
    }
  };

  return (
    <div className="panel onboarding-panel">
      <div className="stepper" aria-label="Project onboarding progress">
        {steps.map((label, index) => <div className={`step-item ${index === step ? "active" : ""} ${index < step ? "done" : ""}`} key={label}><span className="step-number">{index < step ? <Icon name="check" size={13} /> : index + 1}</span><span>{label}</span></div>)}
      </div>

      <div className="onboarding-form-header">
        <p className="eyebrow">Step {step + 1} of {steps.length}</p>
        <h2>{steps[step]}</h2>
        <p>{step === 0 ? "Give your service a clear identity in the workspace." : step === 1 ? "Connect the source that will drive your delivery workflow." : step === 2 ? "Tell OrbitOps how the first environment should receive the release." : "Check the handoff details before the project enters your workspace."}</p>
      </div>

      {step === 0 ? <div className="form-grid">
        <label className="field-label">Project name<input value={form.name} onChange={(event) => updateName(event.target.value)} placeholder="Payments API" autoFocus /></label>
        <label className="field-label">Project slug<input value={form.slug} onChange={(event) => { setSlugTouched(true); update("slug", slugify(event.target.value)); }} placeholder="payments-api" /><small className="field-hint">Used in URLs and deployment identifiers.</small></label>
        <label className="field-label field-full">Description<textarea value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="What does this service do?" /></label>
      </div> : null}

      {step === 1 ? <div className="form-grid">
        <label className="field-label field-full">GitHub repository URL<div className="input-with-icon"><Icon name="github" size={16} /><input value={form.repoUrl} onChange={(event) => update("repoUrl", event.target.value)} placeholder="https://github.com/your-org/your-repo" autoFocus /></div><small className="field-hint">For this prototype, repository connection is simulated against GitHub.</small></label>
        <label className="field-label">Default branch<input value={form.branch} onChange={(event) => update("branch", event.target.value)} placeholder="main" /></label>
        <div className="field-label"><span>Connection status</span><div className={repo ? "form-success" : "callout"}><Icon name={repo ? "check" : "circle-help"} size={15} />{repo ? "Repository looks ready to connect" : "Waiting for a GitHub repository"}</div></div>
        {repo ? <div className="repo-preview field-full"><span className="repo-preview-icon"><Icon name="github" size={17} /></span><span className="repo-preview-copy"><strong>{repo.owner}/{repo.name}</strong><small>{form.repoUrl} · branch {form.branch || "main"}</small></span><span className="status-pill status-green"><span className="status-dot" />Ready</span></div> : null}
      </div> : null}

      {step === 2 ? <div className="form-grid">
        <label className="field-label">Environment<select value={form.environment} onChange={(event) => update("environment", event.target.value as ProjectInput["environment"])}><option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option></select></label>
        <label className="field-label">Build preset<select value={form.buildPreset} onChange={(event) => update("buildPreset", event.target.value as ProjectInput["buildPreset"])}><option value="nextjs">Next.js application</option><option value="node">Node.js service</option><option value="docker">Existing Dockerfile</option></select></label>
        <label className="field-label">Application port<input type="number" min={1} max={65535} value={form.port} onChange={(event) => update("port", Number(event.target.value))} /></label>
        <label className="field-label">Health-check path<input value={form.healthPath} onChange={(event) => update("healthPath", event.target.value)} placeholder="/health" /><small className="field-hint">Kubernetes will use this endpoint during rollout checks.</small></label>
        <div className="callout field-full"><Icon name="shield" size={16} /><span>Secrets stay outside onboarding. Add only secret metadata in the platform until the backend secret store is connected.</span></div>
      </div> : null}

      {step === 3 ? <div className="review-list">
        <div className="review-row"><span>Project</span><strong>{form.name} <span className="muted">({form.slug})</span></strong></div>
        <div className="review-row"><span>Repository</span><strong>{repo ? `${repo.owner}/${repo.name}` : form.repoUrl} · {form.branch}</strong></div>
        <div className="review-row"><span>Environment</span><strong>{form.environment} · {form.buildPreset}</strong></div>
        <div className="review-row"><span>Runtime</span><strong>Port {form.port} · readiness path {form.healthPath}</strong></div>
        <div className="review-row"><span>Next step</span><strong>Open the project dashboard and run a demo pipeline</strong></div>
      </div> : null}

      {error ? <div className="form-error onboarding-error"><Icon name="circle-help" size={15} />{error}</div> : null}
      <div className="form-footer"><span className="form-footer-left">You can change deployment settings later.</span><div className="form-footer-actions">{step > 0 ? <button className="button button-ghost" type="button" onClick={() => { setError(""); setStep((current) => current - 1); }}><Icon name="chevron-left" size={15} />Back</button> : <button className="button button-ghost" type="button" onClick={() => router.push("/projects")}>Cancel</button>}{step < 3 ? <button className="button button-primary" type="button" onClick={next}>Continue <Icon name="chevron-right" size={15} /></button> : <button className="button button-primary" type="button" onClick={create} disabled={creating}>{creating ? <><span className="button-spinner" />Creating</> : <>Create project <Icon name="arrow-up-right" size={15} /></>}</button>}</div></div>
    </div>
  );
}
