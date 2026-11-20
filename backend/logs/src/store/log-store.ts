import { EventEmitter } from "node:events";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LogEntry, LogPhase, LogSource, LogStream } from "@orbitops/integration-common/contract";
import { redact } from "@orbitops/integration-common/redact";
import { stripAnsi } from "../entries/ansi";
import { tailText } from "../entries/entry-text";
import { parseLegacyLine } from "../entries/legacy";

/** One line as the main backend sends it; `seq` is assigned here. */
export interface IngestEntry {
  text: string;
  at?: number;
  source: LogSource;
  phase: LogPhase;
  stream: LogStream;
}

/** `<deploymentId>.meta.json`, next to the log. */
export interface LogMeta {
  projectId: string;
  componentId: string | null;
  provider: string;
  /** The seq the next entry gets. */
  nextSeq: number;
  /** The highest clientSeq accepted; a retried batch at or below it is dropped. */
  lastClientSeq: number;
  bytes: number;
  truncated: boolean;
  /** Set by close: the deployment's final status. */
  status: string | null;
  closedAt: string | null;
}

export type StoreEvent = { type: "entry"; entry: LogEntry } | { type: "done"; status: string };

export interface ReadResult {
  entries: LogEntry[];
  /** The seq to pass as `afterSeq` for the next page. */
  nextSeq: number;
  /** The deployment finished: no more entries will come. */
  complete: boolean;
  status: string | null;
  truncated: boolean;
  /** The log came from a pre-Phase-12 .log file. */
  legacy: boolean;
}

export interface StoreOptions {
  dataDir: string;
  /** Pre-Phase-12 logs: <legacyDir>/<projectId>/<deploymentId>.log, read only. */
  legacyDir: string;
  maxLogBytes: number;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_LINE_CHARS = 16 * 1024;

export class InvalidLogIdError extends Error {}

/**
 * Every deployment's build log, one JSON line per entry, in
 * `<dataDir>/<projectId>/<deploymentId>.jsonl`, plus a small meta file.
 *
 * Appends to one deployment are serialised (a promise chain per id), so seq
 * stays gap-free and in order whatever order requests arrive in. Readers get
 * live entries through `subscribe`. Nothing here merges two deployments:
 * Phase 13's combined log reads each one and merges by `at` itself.
 */
export class LogStore {
  private readonly bus = new EventEmitter().setMaxListeners(0);
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly metas = new Map<string, LogMeta>();

  constructor(private readonly options: StoreOptions) {}

  // ---------------------------------------------------------------- write --

  /**
   * Appends a batch. `clientSeq` numbers the batch's first entry on the
   * sender's side; entries the store has already accepted are dropped, so a
   * retried request never duplicates.
   */
  append(
    deploymentId: string,
    input: { projectId: string; componentId: string | null; provider: string; clientSeq: number; entries: IngestEntry[] },
  ): Promise<{ nextSeq: number; accepted: number }> {
    return this.serial(deploymentId, async () => {
      const meta = await this.meta(deploymentId, input.projectId, { componentId: input.componentId, provider: input.provider });
      const fresh = input.entries.filter((_, i) => input.clientSeq + i > meta.lastClientSeq);
      if (fresh.length === 0) return { nextSeq: meta.nextSeq, accepted: 0 };
      meta.lastClientSeq = Math.max(meta.lastClientSeq, input.clientSeq + input.entries.length - 1);

      const written: LogEntry[] = [];
      let chunk = "";
      for (const item of fresh) {
        if (meta.truncated) break;
        const entry: LogEntry = {
          seq: meta.nextSeq,
          at: Number.isFinite(item.at) && (item.at as number) > 0 ? (item.at as number) : Date.now(),
          source: item.source,
          phase: item.phase,
          stream: item.stream,
          // A backstop: the backend redacted already; this catches token shapes it did not know.
          text: clip(redact(stripAnsi(item.text))),
        };
        let line = JSON.stringify(entry) + "\n";
        if (meta.bytes + chunk.length + line.length > this.options.maxLogBytes) {
          meta.truncated = true;
          const mb = Math.round(this.options.maxLogBytes / 1024 / 1024);
          const cut: LogEntry = { ...entry, source: "orbitops", phase: entry.phase, stream: "info", text: `Log truncated at ${mb} MB; later lines were not kept.` };
          line = JSON.stringify(cut) + "\n";
          written.push(cut);
        } else {
          written.push(entry);
        }
        chunk += line;
        meta.nextSeq++;
      }

      if (chunk) {
        const path = this.logPath(input.projectId, deploymentId);
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, chunk, "utf8");
        meta.bytes += Buffer.byteLength(chunk, "utf8");
      }
      await this.saveMeta(deploymentId, meta);
      for (const entry of written) this.bus.emit(deploymentId, { type: "entry", entry } satisfies StoreEvent);
      return { nextSeq: meta.nextSeq, accepted: fresh.length };
    });
  }

  /** Marks the log finished and returns its last 64 KB as text, for Deployment.logTail. */
  close(deploymentId: string, projectId: string, status: string): Promise<{ tail: string }> {
    return this.serial(deploymentId, async () => {
      const meta = await this.meta(deploymentId, projectId);
      meta.status = status;
      meta.closedAt = new Date().toISOString();
      await this.saveMeta(deploymentId, meta);
      this.bus.emit(deploymentId, { type: "done", status } satisfies StoreEvent);
      const { entries } = await this.read(deploymentId, projectId, { limit: Number.MAX_SAFE_INTEGER });
      return { tail: tailText(entries) };
    });
  }

  // ----------------------------------------------------------------- read --

  async read(deploymentId: string, projectId: string, options: { afterSeq?: number; limit?: number } = {}): Promise<ReadResult> {
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? 5000;
    const meta = await this.existingMeta(deploymentId, projectId);
    const all = meta ? await this.readJsonl(projectId, deploymentId) : null;

    if (all) {
      const after = all.filter((e) => e.seq > afterSeq);
      const entries = after.slice(0, limit);
      const last = entries.at(-1)?.seq ?? afterSeq;
      return {
        entries,
        nextSeq: last,
        complete: Boolean(meta!.status) && entries.length === after.length,
        status: meta!.status,
        truncated: meta!.truncated,
        legacy: false,
      };
    }

    const legacy = await this.readLegacy(projectId, deploymentId);
    if (legacy) {
      const after = legacy.filter((e) => e.seq > afterSeq);
      const entries = after.slice(0, limit);
      return { entries, nextSeq: entries.at(-1)?.seq ?? afterSeq, complete: entries.length === after.length, status: null, truncated: false, legacy: true };
    }
    return { entries: [], nextSeq: afterSeq, complete: false, status: null, truncated: false, legacy: false };
  }

  subscribe(deploymentId: string, listener: (event: StoreEvent) => void): () => void {
    this.bus.on(deploymentId, listener);
    return () => this.bus.off(deploymentId, listener);
  }

  // ------------------------------------------------------------- internals --

  private serial<T>(deploymentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(deploymentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(deploymentId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(deploymentId) === next) this.queues.delete(deploymentId);
      });
    return next;
  }

  logPath(projectId: string, deploymentId: string): string {
    assertId(projectId, "projectId");
    assertId(deploymentId, "deploymentId");
    return join(this.options.dataDir, projectId, `${deploymentId}.jsonl`);
  }

  private metaPath(projectId: string, deploymentId: string): string {
    return join(this.options.dataDir, projectId, `${deploymentId}.meta.json`);
  }

  /** The meta, created when the log is new. A log whose meta was lost is re-counted from the file. */
  private async meta(
    deploymentId: string,
    projectId: string,
    create: { componentId?: string | null; provider?: string } = {},
  ): Promise<LogMeta> {
    const existing = await this.existingMeta(deploymentId, projectId);
    if (existing) return existing;
    return this.rebuildMeta(deploymentId, projectId, [], create);
  }

  private rebuildMeta(
    deploymentId: string,
    projectId: string,
    entries: LogEntry[],
    create: { componentId?: string | null; provider?: string } = {},
  ): LogMeta {
    const meta: LogMeta = {
      projectId,
      componentId: create.componentId ?? null,
      provider: create.provider ?? "unknown",
      nextSeq: (entries.at(-1)?.seq ?? 0) + 1,
      lastClientSeq: 0,
      bytes: entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0),
      truncated: false,
      status: null,
      closedAt: null,
    };
    this.metas.set(deploymentId, meta);
    return meta;
  }

  private async existingMeta(deploymentId: string, projectId: string): Promise<LogMeta | null> {
    const cached = this.metas.get(deploymentId);
    if (cached) return cached;
    try {
      const meta = JSON.parse(await readFile(this.metaPath(projectId, deploymentId), "utf8")) as LogMeta;
      this.metas.set(deploymentId, meta);
      return meta;
    } catch {
      // No meta: a new log, or a .jsonl whose meta was lost (re-counted from the file).
      const entries = await this.readJsonl(projectId, deploymentId);
      return entries ? this.rebuildMeta(deploymentId, projectId, entries) : null;
    }
  }

  private async saveMeta(deploymentId: string, meta: LogMeta): Promise<void> {
    const path = this.metaPath(meta.projectId, deploymentId);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(meta), "utf8");
    await rename(tmp, path);
  }

  private async readJsonl(projectId: string, deploymentId: string): Promise<LogEntry[] | null> {
    let text: string;
    try {
      text = await readFile(this.logPath(projectId, deploymentId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const entries: LogEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LogEntry);
      } catch {
        // A line cut by a crash mid-write; the rest of the file is still good.
      }
    }
    return entries;
  }

  private async readLegacy(projectId: string, deploymentId: string): Promise<LogEntry[] | null> {
    assertId(projectId, "projectId");
    assertId(deploymentId, "deploymentId");
    const path = join(this.options.legacyDir, projectId, `${deploymentId}.log`);
    try {
      const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      return text
        .split("\n")
        .filter((l) => l.trim())
        .map((line, i) => parseLegacyLine(line, i + 1, info.mtime));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

function assertId(value: string, label: string): void {
  // Ids become file names: anything but a plain id could escape the data folder.
  if (!ID.test(value)) throw new InvalidLogIdError(`${label} is not a valid id.`);
}

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)} …(line cut at 16 KB)` : text;
}
