import type { LogPhase, LogSource, LogStream } from "@orbitops/integration-common/contract";
import { badRequest } from "@orbitops/integration-common/provider-error";
import type { IngestEntry } from "../store/log-store";
import { LOG_SOURCES } from "./entry-text";

const PHASES: readonly LogPhase[] = ["setup", "build", "deploy", "runtime"];
const STREAMS: readonly LogStream[] = ["info", "stdout", "stderr"];
export const MAX_BATCH_ENTRIES = 500;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

type Obj = Record<string, unknown>;

export function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw badRequest(`${label} must be an id.`);
  return value;
}

export interface IngestBody {
  projectId: string;
  componentId: string | null;
  provider: string;
  clientSeq: number;
  entries: IngestEntry[];
}

/** POST /deployments/:id/entries, from the main backend. Messages never echo a line's text. */
export function parseIngest(raw: unknown): IngestBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Send a JSON object.");
  const body = raw as Obj;
  const projectId = assertId(body.projectId, "projectId");
  const componentId = body.componentId === null || body.componentId === undefined ? null : assertId(body.componentId, "componentId");
  if (typeof body.provider !== "string" || !/^[a-z_]{1,30}$/.test(body.provider)) throw badRequest("provider must be a provider id.");
  if (!Number.isInteger(body.clientSeq) || (body.clientSeq as number) < 1) throw badRequest("clientSeq must be a positive integer.");
  if (!Array.isArray(body.entries)) throw badRequest("entries must be an array.");
  if (body.entries.length > MAX_BATCH_ENTRIES) throw badRequest(`At most ${MAX_BATCH_ENTRIES} entries per batch.`);

  const entries = body.entries.map((item, index): IngestEntry => {
    if (!item || typeof item !== "object") throw badRequest(`entries[${index}] must be an object.`);
    const e = item as Obj;
    if (typeof e.text !== "string") throw badRequest(`entries[${index}].text must be a string.`);
    if (!LOG_SOURCES.includes(e.source as LogSource)) throw badRequest(`entries[${index}].source is not a log source.`);
    if (!PHASES.includes(e.phase as LogPhase)) throw badRequest(`entries[${index}].phase is not a log phase.`);
    if (!STREAMS.includes(e.stream as LogStream)) throw badRequest(`entries[${index}].stream must be info, stdout or stderr.`);
    if (e.at !== undefined && typeof e.at !== "number") throw badRequest(`entries[${index}].at must be a number.`);
    return { text: e.text, source: e.source as LogSource, phase: e.phase as LogPhase, stream: e.stream as LogStream, ...(typeof e.at === "number" ? { at: e.at } : {}) };
  });
  return { projectId, componentId, provider: body.provider, clientSeq: body.clientSeq as number, entries };
}

/** A non-negative integer query value, or the fallback. */
export function intQuery(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw badRequest("Query numbers must be non-negative integers.");
  return Math.min(n, max);
}
