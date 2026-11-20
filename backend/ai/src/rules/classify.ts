import type { BundleComponent, Category, ContextBundle, Evidence, Hypothesis, Provider, Severity } from "../types";

/**
 * The rule pass (Phase 13): regex rules over each component's log excerpt and
 * runtime lines, plus signals from outside the logs (pre-flight, failed
 * components, a failed release, env changes not yet deployed).
 *
 * Ported from the Groq demo's failure classifier
 * (backend/lib/log-analysis/xxx_failure-classifier.ts) and extended with
 * provider rules. Its findings are HYPOTHESES the model is asked to verify;
 * with no model they are the answer.
 */

interface LineRule {
  category: Category;
  severity: Severity;
  label: string;
  patterns: RegExp[];
  /** Only for these providers; all when absent. */
  providers?: Provider[];
}

const LINE_RULES: LineRule[] = [
  {
    category: "MISSING_ENV_VARIABLE",
    severity: "high",
    label: "an environment variable the app reads is not set",
    patterns: [
      /\b[A-Z][A-Z0-9_]{2,}\b (?:is not defined|is not set|is required|must be set|is missing)/,
      /\bmissing (?:required )?(?:environment )?variable\b/i,
      /\b(?:environment variable|env var)\b.*\bnot (?:set|found|configured|defined)\b/i,
      /\bprocess\.env\.[A-Z0-9_]+ is undefined\b/i,
    ],
  },
  {
    category: "MISSING_DEPENDENCY",
    severity: "high",
    label: "a module or package cannot be found",
    patterns: [/Module not found:\s*Can't resolve/i, /Cannot find module ['"][^'"]+['"]/i, /ERR_MODULE_NOT_FOUND/i, /\bMODULE_NOT_FOUND\b/, /npm ERR! (?:code )?E404/i, /No matching version found for/i],
  },
  {
    category: "TYPESCRIPT_ERROR",
    severity: "high",
    label: "the TypeScript build has type errors",
    patterns: [/\berror TS\d{4}\b/i, /\bType .+ is not assignable to type\b/i, /\bFound \d+ errors?\b/i, /Type error:/i],
  },
  {
    category: "BUILD_COMMAND_FAILED",
    severity: "high",
    label: "the build command failed",
    patterns: [
      /Command "[^"]+" exited with \d+/i,
      /Build failed because of webpack errors/i,
      /==> Build failed/i,
      /npm ERR! (?:Failed at|code ELIFECYCLE)/i,
      /error Command failed with exit code \d+/i,
      /\bfailed to solve\b/i,
      /\bCOPY failed\b/i,
    ],
  },
  {
    category: "PORT_BINDING",
    severity: "high",
    label: "the service does not listen on the port the platform expects",
    providers: ["render", "local_docker"],
    patterns: [/No open ports detected/i, /Port scan timeout reached/i, /\bEADDRINUSE\b/i, /address already in use/i],
  },
  {
    category: "HEALTH_CHECK_FAILED",
    severity: "high",
    label: "the health check never passed",
    patterns: [/health ?check (?:failed|timed out|did not pass)/i, /failed health checks?/i, /Timed out waiting for .* healthy/i],
  },
  {
    category: "START_COMMAND_FAILED",
    severity: "high",
    label: "the app crashed while starting",
    providers: ["render", "local_docker"],
    patterns: [/==> Exited with status [1-9]\d*/i, /Application exited early/i, /process exited with code [1-9]\d*/i, /Error: Cannot find module '\/opt\/render/i, /exited with code [1-9]\d* during start/i],
  },
  {
    category: "DATABASE_CONNECTION",
    severity: "high",
    label: "the app cannot reach or log in to its database",
    patterns: [
      /\bECONNREFUSED\b.*(?:5432|database|postgres)/i,
      /password authentication failed/i,
      /(?:SSL|TLS) (?:connection )?(?:is )?required/i,
      /no pg_hba\.conf entry/i,
      /database "[^"]+" does not exist/i,
      /Can't reach database server/i,
      /\bP1001\b|\bP1000\b|\bP1017\b/,
      /getaddrinfo ENOTFOUND .*neon\.tech/i,
    ],
  },
  {
    category: "DATABASE_MIGRATION",
    severity: "high",
    label: "the database schema is missing or out of date",
    patterns: [/relation "[^"]+" does not exist/i, /The table `[^`]+` does not exist/i, /\bP3009\b|\bP3018\b|\bP2021\b/, /migrate (?:deploy )?failed/i],
  },
  {
    category: "CORS",
    severity: "medium",
    label: "the browser blocked a cross-origin request",
    patterns: [/blocked by CORS policy/i, /No 'Access-Control-Allow-Origin' header/i, /CORS (?:error|request did not succeed)/i],
  },
  {
    category: "API_URL_MISMATCH",
    severity: "medium",
    label: "the frontend calls a backend URL that does not answer",
    providers: ["vercel"],
    patterns: [/fetch failed/i, /ECONNREFUSED .*(?:onrender\.com|localhost:3001|127\.0\.0\.1)/i, /(?:NEXT_PUBLIC|VITE|REACT_APP|PUBLIC)_API_URL.*(?:undefined|not defined)/i],
  },
  {
    category: "OUT_OF_MEMORY",
    severity: "high",
    label: "the process ran out of memory",
    patterns: [/JavaScript heap out of memory/i, /Out of memory/i, /OOMKilled/i, /exceeded (?:the )?memory limit/i, /SIGKILL/],
  },
  {
    category: "TIMEOUT",
    severity: "medium",
    label: "something timed out",
    patterns: [/exceeded timeout/i, /build process timed out/i, /\bETIMEDOUT\b/i, /Task timed out after/i, /FUNCTION_INVOCATION_TIMEOUT/i],
  },
  {
    category: "PROVIDER_AUTH",
    severity: "high",
    label: "the provider rejected the saved credential",
    patterns: [/rejected the saved (?:token|API key)/i, /Reconnect (?:Vercel|Render|Neon) in Settings/i],
  },
  {
    category: "PROVIDER_LIMIT",
    severity: "medium",
    label: "a provider plan or rate limit was hit",
    patterns: [/plan(?:'s)? (?:project )?limit/i, /rate[- ]limit/i, /exceeded your (?:quota|limit)/i],
  },
  {
    category: "RUNTIME_EXCEPTION",
    severity: "medium",
    label: "the running app throws errors",
    patterns: [/\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/, /Unhandled (?:exception|rejection|promise rejection)/i, /Application crashed/i, /Traceback \(most recent call last\)/, /\b500 Internal Server Error\b/i],
  },
];

const FAILED = new Set(["failed"]);

/** Every hypothesis the rules can find in the bundle, the strongest first. */
export function classify(bundle: ContextBundle): Hypothesis[] {
  const found: Hypothesis[] = [];
  const byKey = new Map<string, Hypothesis>();
  const add = (h: Hypothesis) => {
    const key = `${h.category}:${h.componentId ?? "-"}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const e of h.evidence) if (existing.evidence.length < 5 && !existing.evidence.some((x) => x.line === e.line)) existing.evidence.push(e);
      return;
    }
    byKey.set(key, h);
    found.push(h);
  };

  for (const component of bundle.components) {
    for (const { line, source, deploymentId } of linesOf(component)) {
      for (const rule of LINE_RULES) {
        if (rule.providers && !rule.providers.includes(component.provider)) continue;
        if (rule.patterns.some((p) => p.test(line))) {
          add({
            category: rule.category,
            severity: rule.severity,
            componentId: component.id,
            evidence: [{ componentId: component.id, source, line, deploymentId }],
            rule: `${component.name}: ${rule.label}`,
          });
          break; // one category per line: the first (most specific) rule wins
        }
      }
    }
    for (const h of signalsOf(component, bundle)) add(h);
  }

  // Pre-flight failures that are not about one component's logs.
  for (const check of bundle.preflight.filter((c) => c.status === "fail")) {
    const component = bundle.components.find((c) => check.id.endsWith(`:${c.id}`)) ?? null;
    add({
      category: check.id.startsWith("env:") ? "MISSING_ENV_VARIABLE" : check.id.startsWith("credential:") ? "PROVIDER_AUTH" : "CONFIGURATION",
      severity: "high",
      componentId: component?.id ?? null,
      evidence: [{ componentId: component?.id ?? null, source: "preflight", line: check.message, deploymentId: null }],
      rule: `pre-flight check ${check.id} fails`,
    });
  }

  if (bundle.release && FAILED.has(bundle.release.status) && bundle.release.errorMessage) {
    add({
      category: "UNKNOWN",
      severity: "high",
      componentId: null,
      evidence: [{ componentId: null, source: "release", line: bundle.release.errorMessage, deploymentId: null }],
      rule: `Deploy all #${bundle.release.number} failed at stage ${bundle.release.stage}`,
    });
  }

  const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return found.sort((a, b) => rank[a.severity] - rank[b.severity] || Number(a.category === "UNKNOWN") - Number(b.category === "UNKNOWN"));
}

/** Signals beyond the log lines: a failed component, changes not deployed, a URL problem. */
function signalsOf(component: BundleComponent, bundle: ContextBundle): Hypothesis[] {
  const out: Hypothesis[] = [];
  const latest = component.deployments[0];
  if (latest && FAILED.has(latest.status) && latest.errorMessage) {
    out.push({
      category: "UNKNOWN",
      severity: "high",
      componentId: component.id,
      evidence: [{ componentId: component.id, source: "deployment", line: latest.errorMessage, deploymentId: latest.id }],
      rule: `${component.name}: its latest deployment failed`,
    });
  }
  if (component.env.pendingRedeploy) {
    out.push({
      category: "CONFIGURATION",
      severity: "low",
      componentId: component.id,
      evidence: [],
      rule: `${component.name}: its env vars changed after its last successful deploy; it does not have them yet`,
    });
  }
  if (component.kind === "frontend" && component.provider === "vercel") {
    const backends = bundle.components.filter((c) => c.kind === "backend");
    if (backends.length === 1 && !backends[0].url) {
      out.push({
        category: "API_URL_MISMATCH",
        severity: "medium",
        componentId: component.id,
        evidence: [],
        rule: `${component.name}: the backend ${backends[0].name} has no URL yet, so the frontend has no API URL to call`,
      });
    }
  }
  if (component.kind === "backend" && component.provider === "render") {
    const db = bundle.components.find((c) => c.kind === "database");
    if (db && !component.env.systemKeys.includes("DATABASE_URL")) {
      out.push({
        category: "DATABASE_CONNECTION",
        severity: "medium",
        componentId: component.id,
        evidence: [],
        rule: `${component.name}: a database is configured but DATABASE_URL is not among the keys it gets`,
      });
    }
  }
  return out;
}

/** The lines the rules read: the log excerpt (stderr and error-looking first) and the runtime snapshot. */
function linesOf(component: BundleComponent): Array<{ line: string; source: string; deploymentId: string | null }> {
  const out: Array<{ line: string; source: string; deploymentId: string | null }> = [];
  for (const e of component.log?.entries ?? []) out.push({ line: e.text, source: e.source, deploymentId: component.log!.deploymentId });
  for (const l of component.runtime?.lines ?? []) out.push({ line: l.text, source: `${component.provider} runtime`, deploymentId: null });
  return out;
}

/** The categories as the prompt and the UI describe them. */
export const CATEGORY_LABEL: Record<Category, string> = {
  MISSING_ENV_VARIABLE: "Missing environment variable",
  MISSING_DEPENDENCY: "Missing dependency",
  TYPESCRIPT_ERROR: "TypeScript error",
  BUILD_COMMAND_FAILED: "Build failed",
  START_COMMAND_FAILED: "App crashed on start",
  PORT_BINDING: "Wrong port",
  HEALTH_CHECK_FAILED: "Health check failed",
  DATABASE_CONNECTION: "Database connection",
  DATABASE_MIGRATION: "Database schema",
  API_URL_MISMATCH: "Frontend cannot reach the backend",
  CORS: "CORS",
  OUT_OF_MEMORY: "Out of memory",
  TIMEOUT: "Timeout",
  PROVIDER_AUTH: "Provider account",
  PROVIDER_LIMIT: "Provider limit",
  CONFIGURATION: "Configuration",
  RUNTIME_EXCEPTION: "Runtime error",
  UNKNOWN: "Failure",
};

export type { Evidence };
