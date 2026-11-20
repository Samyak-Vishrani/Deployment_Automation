/**
 * The wire contract every integration service shares with the main backend:
 * provider states, log lines and the event batches posted to
 * /api/internal/provider-events.
 *
 * The main backend mirrors these in backend/lib/providers/vercel-service.types.ts;
 * change both together. Request shapes that differ per provider (the component
 * and repo specs, the deploy request) stay in each service's own src/types.ts.
 */

/** A provider deployment's state, the same vocabulary for every provider. */
export type NormalisedStatus = "queued" | "deploying" | "building" | "live" | "failed" | "cancelled";

export const TERMINAL_STATES: ReadonlySet<NormalisedStatus> = new Set(["live", "failed", "cancelled"]);

export const isTerminal = (state: string): boolean => TERMINAL_STATES.has(state as NormalisedStatus);

/** "git": the provider read the repository itself. "upload": we sent the files (Vercel only). */
export type SourceMode = "git" | "upload";

export interface EnvVar {
  key: string;
  value: string;
}

export interface LogLine {
  /** The provider's id for the line (or a serial), for de-duplication across polls. */
  id: string;
  /** ms since epoch. */
  at: number;
  stream: "stdout" | "stderr" | "info";
  text: string;
  /** Phase 12: Render tags build vs app output; Vercel's build events are all "build". */
  phase?: "build" | "runtime";
}

/**
 * One line of a deploy's log as it travels in a "logs" event (Phase 12):
 * - `origin: "orbitops"`: written by the integration service itself
 *   ("==> Preparing Vercel project…"); the backend stores it as source "orbitops";
 * - `origin: "provider"` (or absent, before Phase 12): pulled from the
 *   provider; stored with the provider as source.
 */
export interface EventLogLine {
  at: number;
  stream: LogLine["stream"];
  text: string;
  phase?: "build" | "deploy" | "runtime";
  origin?: "orbitops" | "provider";
}

// ----------------------------------------------------------- logs (phase 12) --

/** Who wrote a stored log line. */
export type LogSource = "orbitops" | "vercel" | "render" | "neon" | "docker";
/** Where in a deploy it was written. */
export type LogPhase = "setup" | "build" | "deploy" | "runtime";
export type LogStream = "info" | "stdout" | "stderr";

/**
 * A stored build-log line (backend/logs, one JSON line per entry). `seq` is
 * assigned by the logs service: monotonic per deployment, the SSE event id.
 */
export interface LogEntry {
  seq: number;
  /** ms since epoch: the provider's time when it gave one, else when written. */
  at: number;
  source: LogSource;
  phase: LogPhase;
  stream: LogStream;
  text: string;
}

/** One line of a running app's log, tailed live and never stored. */
export interface RuntimeLogLine {
  /** The provider's id (Render log id, Vercel rowId), for de-duplication. */
  id: string;
  at: number;
  stream: "stdout" | "stderr";
  level?: string;
  text: string;
  request?: { method?: string; path?: string; status?: number };
}

export type RuntimeEndReason = "idle" | "max_duration" | "redeployed" | "error" | "upstream_closed";

/** What a runtime-log stream carries, as NDJSON from backend/logs. */
export type RuntimeLogEvent =
  | { type: "line"; line: RuntimeLogLine }
  | { type: "notice"; text: string }
  | { type: "end"; reason: RuntimeEndReason; message: string }
  | { type: "heartbeat" };

/** Events delivered to the main backend, in order, batched with a sequence number. */
export type ProviderEvent =
  | { type: "status"; providerStatus: NormalisedStatus; errorMessage?: string }
  | { type: "resource"; componentId: string; providerResourceId: string; projectName: string }
  | {
      type: "deployment";
      providerDeploymentId: string;
      sourceMode: SourceMode;
      url: string | null;
      inspectorUrl: string | null;
    }
  | { type: "logs"; lines: EventLogLine[] }
  | {
      type: "terminal";
      status: "live" | "failed" | "cancelled";
      productionUrl?: string | null;
      errorMessage?: string | null;
    };

export interface EventBatch {
  deploymentId: string;
  seq: number;
  events: ProviderEvent[];
}
