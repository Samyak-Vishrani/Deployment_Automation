import type { BundleComponent, BundleLog, ContextBundle } from "../types";

const time = (at: number) => (Number.isFinite(at) && at > 0 ? new Date(at).toISOString().slice(11, 19) : "--:--:--");

/** Logs as fenced, untrusted data. Gaps in seq are shown, so the model knows lines were left out. */
export function renderLog(component: BundleComponent, log: BundleLog, label: string): string {
  const lines: string[] = [];
  let lastSeq = 0;
  for (const e of log.entries) {
    if (lastSeq && e.seq > lastSeq + 1) lines.push(`… ${e.seq - lastSeq - 1} line(s) omitted …`);
    lines.push(`${time(e.at)} [${e.source}${e.stream === "stderr" ? " stderr" : ""}] ${e.text}${e.repeat && e.repeat > 1 ? `  (×${e.repeat})` : ""}`);
    lastSeq = e.seq + Math.max(0, (e.repeat ?? 1) - 1);
  }
  const head = `${label} of ${component.name} (deployment ${log.deploymentId}; ${log.totalLines} lines in total, ${log.errorLines} error-looking${log.truncated ? ", trimmed" : ""})`;
  return `<logs component="${component.name}" provider="${component.provider}" deployment="${log.deploymentId}">\n# ${head}\n${lines.join("\n")}\n</logs>`;
}

export function renderRuntime(component: BundleComponent): string {
  const rt = component.runtime;
  if (!rt) return "";
  const body = rt.lines.length
    ? rt.lines.map((l) => `${time(l.at)} [${l.level ?? l.stream}] ${l.request ? `${[l.request.method, l.request.path, l.request.status].filter(Boolean).join(" ")} · ` : ""}${l.text}`).join("\n")
    : `(no lines${rt.note ? `: ${rt.note}` : ""})`;
  return `<runtime component="${component.name}" provider="${component.provider}">\n${body}\n</runtime>`;
}

/** One component's facts: settings, env KEYS, recent deployments. */
export function renderComponent(c: BundleComponent): string {
  const s = c.settings;
  const settings = [
    `folder ${s.rootDir}`,
    s.framework && `framework ${s.framework}`,
    s.installCmd && `install "${s.installCmd}"`,
    s.buildCmd && `build "${s.buildCmd}"`,
    s.startCmd && `start "${s.startCmd}"`,
    s.outputDir && `output ${s.outputDir}`,
    s.nodeVersion && `node ${s.nodeVersion}`,
    s.healthCheckPath && `health check ${s.healthCheckPath}`,
  ]
    .filter(Boolean)
    .join(", ");
  const deployments = c.deployments
    .map(
      (d) =>
        `  - ${d.id}: ${d.status}${d.providerStatus ? ` (${d.providerStatus})` : ""}, ${d.trigger}, ${d.commitSha?.slice(0, 7) ?? "no sha"}, ${d.queuedAt}${d.errorMessage ? `, error: ${d.errorMessage}` : ""}`,
    )
    .join("\n");
  return [
    `## ${c.name} (id ${c.id}): ${c.kind} on ${c.provider}, status ${c.status}${c.url ? `, ${c.url}` : ""}`,
    `settings: ${settings || "none"}`,
    `env var keys (values are never shown): own [${c.env.keys.join(", ")}]${c.env.sharedKeys.length ? `, shared [${c.env.sharedKeys.join(", ")}]` : ""}${c.env.systemKeys.length ? `, set by OrbitOps [${c.env.systemKeys.join(", ")}]` : ""}${c.env.pendingRedeploy ? " — CHANGED SINCE THE LAST SUCCESSFUL DEPLOY, NOT YET APPLIED" : ""}`,
    `recent deployments (newest first):\n${deployments || "  (none)"}`,
  ].join("\n");
}

/** The whole bundle as the prompt's context section. */
export function renderBundle(bundle: ContextBundle): string {
  const parts: string[] = [];
  parts.push(`# Project ${bundle.project.name}${bundle.project.repo ? ` (${bundle.project.repo}@${bundle.project.branch ?? "?"})` : ""}`);
  if (bundle.release) {
    const r = bundle.release;
    parts.push(
      `# Latest Deploy all: #${r.number}, ${r.status}, stage ${r.stage}${r.errorMessage ? `, error: ${r.errorMessage}` : ""}\n` +
        r.steps.map((s) => `  - ${s.kind} ${s.componentName}: ${s.status ?? "not started"}`).join("\n"),
    );
  }
  const failing = bundle.preflight.filter((c) => c.status !== "pass");
  parts.push(
    `# Pre-flight: ${bundle.preflight.length - failing.length}/${bundle.preflight.length} checks pass` +
      (failing.length ? `\n${failing.map((c) => `  - ${c.status.toUpperCase()} ${c.id}: ${c.message}`).join("\n")}` : ""),
  );
  if (bundle.repoAnalysis?.database?.detected) parts.push(`# Repo analysis: the code uses a ${bundle.repoAnalysis.database.engine ?? "SQL"} database.`);
  for (const c of bundle.components) {
    parts.push(renderComponent(c));
    if (c.log) parts.push(renderLog(c, c.log, "Latest build/deploy log"));
    if (c.previousSuccessLog) parts.push(renderLog(c, c.previousSuccessLog, "Previous SUCCESSFUL build log, for comparison"));
    if (c.runtime) parts.push(renderRuntime(c));
  }
  if (bundle.notes.length) parts.push(`# Not available\n${bundle.notes.map((n) => `- ${n}`).join("\n")}`);
  return parts.join("\n\n");
}
