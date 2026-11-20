import type { AnalysisResult, BundleComponent, Category, ContextBundle, Hypothesis, Scope, Step, StepWhere, Verdict } from "../types";
import { CATEGORY_LABEL } from "./classify";

type StepTemplate = (h: Hypothesis, c: BundleComponent | null) => Omit<Step, "order" | "problemIds" | "componentId">;

const keyIn = (h: Hypothesis) => /\b([A-Z][A-Z0-9]*_[A-Z0-9_]{2,})\b/.exec(h.evidence.map((e) => e.line).join(" "))?.[1] ?? null;
const moduleIn = (h: Hypothesis) => /(?:Can't resolve|Cannot find module) ['"]([^'"]+)['"]/.exec(h.evidence.map((e) => e.line).join(" "))?.[1] ?? null;
const where = (c: BundleComponent | null) => (c ? `${c.name}` : "the component");
const dir = (c: BundleComponent | null) => (c && c.settings.rootDir !== "." ? c.settings.rootDir : "the repository root");

/** What to do about each category, without a model. Kept generic and safe. */
const TEMPLATES: Record<Category, StepTemplate> = {
  MISSING_ENV_VARIABLE: (h, c) => {
    const key = keyIn(h);
    return {
      title: key ? `Add ${key} to ${where(c)}` : `Add the missing env var to ${where(c)}`,
      detail: `Open Configure → ${where(c)} → Environment and add ${key ?? "the variable the log names"} with its value, then Save & redeploy.`,
      where: "environment",
      command: null,
      file: null,
      envKey: key,
    };
  },
  MISSING_DEPENDENCY: (h, c) => {
    const mod = moduleIn(h);
    const pkg = mod && !mod.startsWith(".") && !mod.startsWith("/") ? mod.split("/").slice(0, mod.startsWith("@") ? 2 : 1).join("/") : null;
    return {
      title: mod ? `Fix the import of ${mod}` : "Add the missing package",
      detail: pkg
        ? `Add ${pkg} to the dependencies in ${dir(c)}/package.json, commit, and push.`
        : `Check the import path in ${dir(c)}, the file name's case and its extension, then commit and push.`,
      where: "repository",
      command: pkg ? `npm install ${pkg}` : null,
      file: `${dir(c)}/package.json`,
      envKey: null,
    };
  },
  TYPESCRIPT_ERROR: (_h, c) => ({
    title: "Fix the type errors",
    detail: `Run the type check in ${dir(c)}, fix the files the log names, then commit and push.`,
    where: "repository",
    command: "npx tsc --noEmit",
    file: null,
    envKey: null,
  }),
  BUILD_COMMAND_FAILED: (_h, c) => ({
    title: `Make ${where(c)}'s build pass`,
    detail: `Run the build command locally in ${dir(c)} to see the full error, fix it, then redeploy. If the command itself is wrong, change it in Configure.`,
    where: "configure",
    command: c?.settings.buildCmd ?? "npm run build",
    file: null,
    envKey: null,
  }),
  START_COMMAND_FAILED: (_h, c) => ({
    title: `Fix ${where(c)}'s start command`,
    detail: `The app exits while starting. Check the start command in Configure (it must start the server that the build produced) and run it locally in ${dir(c)}.`,
    where: "configure",
    command: c?.settings.startCmd ?? "npm start",
    file: null,
    envKey: null,
  }),
  PORT_BINDING: (_h, c) => ({
    title: "Listen on the platform's port",
    detail: `The server must listen on process.env.PORT and on host 0.0.0.0, not a fixed port or localhost. Change the listen call in ${dir(c)}, commit and push.`,
    where: "repository",
    command: null,
    file: null,
    envKey: "PORT",
  }),
  HEALTH_CHECK_FAILED: (_h, c) => ({
    title: "Make the health check pass",
    detail: `The health check path (${c?.settings.healthCheckPath ?? "not set"}) must answer 200 quickly. Fix the route, or change or clear the path in Configure.`,
    where: "configure",
    command: null,
    file: null,
    envKey: null,
  }),
  DATABASE_CONNECTION: (_h, c) => ({
    title: "Connect to the Neon database",
    detail: `Use DATABASE_URL (OrbitOps sets it on ${where(c)} when the project has a Neon database); do not hard-code a connection string. Make sure the database is provisioned, keep SSL on (sslmode=require), then redeploy.`,
    where: "redeploy",
    command: null,
    file: null,
    envKey: "DATABASE_URL",
  }),
  DATABASE_MIGRATION: (_h, c) => ({
    title: "Run the database migrations",
    detail: `Add the migration to ${where(c)}'s build command in Configure, for example "npm install && npx prisma migrate deploy". With Prisma, set directUrl = env("DATABASE_URL_UNPOOLED").`,
    where: "configure",
    command: "npx prisma migrate deploy",
    file: null,
    envKey: "DATABASE_URL_UNPOOLED",
  }),
  API_URL_MISMATCH: (_h, c) => ({
    title: "Point the frontend at the live backend",
    detail: `Deploy the backend first (Deploy all does this in order), so ${where(c)} is built with the backend's URL. The code must read the URL from the framework's public variable (e.g. NEXT_PUBLIC_API_URL).`,
    where: "redeploy",
    command: null,
    file: null,
    envKey: null,
  }),
  CORS: () => ({
    title: "Allow the frontend's origin on the backend",
    detail: "Add the frontend's URL to the backend's CORS configuration (e.g. a CORS_ORIGIN env var on the backend), then redeploy the backend.",
    where: "environment",
    command: null,
    file: null,
    envKey: "CORS_ORIGIN",
  }),
  OUT_OF_MEMORY: (_h, c) => ({
    title: "Reduce memory use, or use a bigger plan",
    detail: `The process was killed for using too much memory. Reduce what ${where(c)} loads at once, or choose a larger plan on the provider.`,
    where: "provider_dashboard",
    command: null,
    file: null,
    envKey: null,
  }),
  TIMEOUT: (_h, c) => ({
    title: "Find what is slow",
    detail: `Something in ${where(c)} took too long. The log lines around the timeout show which step; speed it up or move it out of the build.`,
    where: "repository",
    command: null,
    file: null,
    envKey: null,
  }),
  PROVIDER_AUTH: () => ({
    title: "Reconnect the provider account",
    detail: "Open Settings → Integrations and paste a new token or API key for the provider that rejected the saved one.",
    where: "settings",
    command: null,
    file: null,
    envKey: null,
  }),
  PROVIDER_LIMIT: () => ({
    title: "Free up the provider's limit",
    detail: "Delete an unused project or service on the provider's dashboard, wait for the rate limit to reset, or upgrade the plan.",
    where: "provider_dashboard",
    command: null,
    file: null,
    envKey: null,
  }),
  CONFIGURATION: (h, c) => ({
    title: h.rule.includes("env vars changed") ? `Redeploy ${where(c)}` : "Fix the failing pre-flight check",
    detail: h.rule.includes("env vars changed")
      ? `${where(c)}'s env vars changed after its last deploy; redeploy it so it gets them.`
      : `${h.evidence[0]?.line ?? h.rule}. Fix it in Configure, then run pre-flight again.`,
    where: h.rule.includes("env vars changed") ? "redeploy" : "configure",
    command: null,
    file: null,
    envKey: null,
  }),
  RUNTIME_EXCEPTION: (_h, c) => ({
    title: "Fix the error the app throws",
    detail: `The running app throws an error; the stack trace in the evidence points at the file. Fix it in ${dir(c)}, commit and push.`,
    where: "repository",
    command: null,
    file: null,
    envKey: null,
  }),
  UNKNOWN: (_h, c) => ({
    title: `Read ${where(c)}'s log around the failure`,
    detail: "The rules could not tell the cause. Open the build log on the Logs page, look at the first error, and ask the AI with an OpenAI key set for a deeper answer.",
    where: "configure",
    command: null,
    file: null,
    envKey: null,
  }),
};

/**
 * A complete answer from the rules alone: used when there is no OpenAI key,
 * or OpenAI failed. Deliberately cautious: confidence never above 0.6.
 */
export function ruleBasedResult(bundle: ContextBundle, hypotheses: Hypothesis[], scope: Scope): AnalysisResult {
  const components = bundle.components;
  const byId = new Map(components.map((c) => [c.id, c]));
  // A specific category beats the generic "it failed" for the same component.
  const specific = new Set(hypotheses.filter((h) => h.category !== "UNKNOWN").map((h) => h.componentId));
  const kept = hypotheses.filter((h) => h.category !== "UNKNOWN" || !specific.has(h.componentId)).slice(0, 6);

  const problems = kept.map((h, i) => ({
    id: `p${i + 1}`,
    title: `${CATEGORY_LABEL[h.category]}${h.componentId && byId.get(h.componentId) ? ` in ${byId.get(h.componentId)!.name}` : ""}`,
    severity: h.severity,
    category: h.category,
    componentIds: h.componentId ? [h.componentId] : [],
    rootCause: `Detected by a rule: ${h.rule}.`,
    confidence: h.evidence.length > 0 ? (h.severity === "low" ? 0.4 : 0.6) : 0.35,
    evidence: h.evidence.slice(0, 3),
  }));

  const steps: Step[] = [];
  kept.forEach((h, i) => {
    const c = h.componentId ? (byId.get(h.componentId) ?? null) : null;
    const t = TEMPLATES[h.category](h, c);
    if (steps.some((s) => s.title === t.title)) return;
    steps.push({ order: 0, ...t, problemIds: [`p${i + 1}`], componentId: c?.id ?? null });
  });
  if (steps.length > 0 && !steps.some((s) => s.where === "redeploy")) {
    steps.push({
      order: 0,
      title: scope === "project" ? "Deploy again" : "Redeploy this component",
      detail: scope === "project" ? "After the fixes, run Deploy all so every part is rebuilt in order." : "After the fix, deploy it again and watch the build log.",
      problemIds: problems.map((p) => p.id),
      where: "redeploy",
      componentId: scope === "component" ? (components[0]?.id ?? null) : null,
      command: null,
      file: null,
      envKey: null,
    });
  }
  steps.forEach((s, i) => (s.order = i + 1));

  const failingIds = new Set(problems.filter((p) => p.severity === "high" || p.severity === "critical").flatMap((p) => p.componentIds));
  const warnIds = new Set(problems.flatMap((p) => p.componentIds));
  const status = (c: BundleComponent) =>
    failingIds.has(c.id) || c.status === "failed" ? "failing" : warnIds.has(c.id) ? "warning" : c.status === "live" ? "ok" : "unknown";

  const anyLog = components.some((c) => c.log || c.runtime || c.deployments.length > 0);
  const verdict: Verdict =
    problems.some((p) => p.severity === "high" || p.severity === "critical") || bundle.release?.status === "failed"
      ? "failing"
      : problems.length > 0
        ? "degraded"
        : anyLog && components.every((c) => c.status === "live")
          ? "healthy"
          : "unknown";

  const summary =
    verdict === "healthy"
      ? "No problem found: every component is live and the logs show no errors the rules recognise."
      : verdict === "unknown"
        ? "Not enough to go on: nothing has been deployed yet, or the logs are not available."
        : `${problems.length} problem${problems.length === 1 ? "" : "s"} found by the built-in rules: ${problems.map((p) => p.title).join("; ")}.`;

  return {
    verdict,
    summary,
    problems,
    steps,
    components: components.map((c) => ({ componentId: c.id, status: status(c), note: `${c.provider} · ${c.status}` })),
    providerNotes: null,
    followUps: verdict === "healthy" ? [] : ["Set OPENAI_API_KEY in backend/ai/.env for a full AI analysis of the logs."],
  };
}

export type { StepWhere };
