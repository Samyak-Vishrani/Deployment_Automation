import { EventEmitter } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { redact } from "@/lib/common/redact";

export interface LogEvent {
  type: "line" | "done";
  data: string;
}

/**
 * Resolves DATA_DIR against the backend folder.
 *
 * Next.js always starts with process.cwd() at the app root - the folder holding
 * next.config.ts - regardless of where npm was invoked from, so it is the
 * stable anchor here. The NestJS original used __dirname because its two entry
 * points (ts-node src/ and node dist/) sat at different depths; a bundled
 * Next.js route has no meaningful __dirname at all.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DATA_DIR?.trim();
  if (configured) {
    return isAbsolute(configured)
      ? configured
      : resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  }
  // turbopackIgnore, or the bundler's static analysis sees an unbounded
  // process.cwd() read and traces the entire project into the server output -
  // every source file and the public folder with it. This path is resolved at
  // runtime from the environment and is never a build input.
  return resolve(/* turbopackIgnore: true */ process.cwd(), "data");
}

/** One open log file, fanning every line out to live subscribers as it writes. */
export class DeploymentLogWriter {
  private stream: WriteStream;
  private tail: string[] = [];

  constructor(
    private readonly deploymentId: string,
    path: string,
    private readonly bus: EventEmitter,
    /** Literal secrets to scrub from every line before it is written. */
    private secrets: (string | undefined | null)[] = [],
  ) {
    this.stream = createWriteStream(path, { flags: "a" });
  }

  /**
   * Registers a secret discovered after the log was opened - the installation
   * token, which cannot be minted until the deployment is already under way.
   * Everything written from here on is scrubbed of it.
   */
  addSecret(secret: string | undefined | null): void {
    if (secret) {
      this.secrets = [...this.secrets, secret];
    }
  }

  /** A phase marker, so the log reads as one narrative. */
  section(title: string): void {
    this.write(`\n==> ${title}`);
  }

  write(line: string): void {
    const clean = redact(line, this.secrets);
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${clean}`;
    this.stream.write(stamped + "\n");

    // Kept in memory so the terminal state can persist a tail without
    // re-reading the file.
    this.tail.push(stamped);
    if (this.tail.length > 2000) {
      this.tail.splice(0, this.tail.length - 2000);
    }

    this.bus.emit(this.deploymentId, { type: "line", data: stamped } satisfies LogEvent);
  }

  /** Last ~64KB, for Deployment.logTail. */
  tailText(maxBytes = 64 * 1024): string {
    let out = "";
    for (let i = this.tail.length - 1; i >= 0; i--) {
      const next = this.tail[i] + "\n";
      if (out.length + next.length > maxBytes) break;
      out = next + out;
    }
    return out;
  }

  async close(status: string): Promise<void> {
    await new Promise<void>((res) => this.stream.end(res));
    this.bus.emit(this.deploymentId, {
      type: "done",
      data: JSON.stringify({ status }),
    } satisfies LogEvent);
  }
}

export class DeploymentLogsService {
  private readonly dataDir = resolveDataDir();
  /**
   * Node's default max listener count is 10, which a handful of open log views
   * would trip, producing a spurious leak warning.
   */
  private readonly bus = new EventEmitter().setMaxListeners(0);

  logPath(projectId: string, deploymentId: string): string {
    return join(this.dataDir, "logs", projectId, `${deploymentId}.log`);
  }

  async open(
    projectId: string,
    deploymentId: string,
    secrets: (string | undefined | null)[] = [],
  ): Promise<DeploymentLogWriter> {
    const path = this.logPath(projectId, deploymentId);
    await mkdir(dirname(path), { recursive: true });
    return new DeploymentLogWriter(deploymentId, path, this.bus, secrets);
  }

  async read(projectId: string, deploymentId: string): Promise<string> {
    try {
      return await readFile(this.logPath(projectId, deploymentId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  /** Subscribe to live lines. Returns an unsubscribe function. */
  subscribe(deploymentId: string, listener: (event: LogEvent) => void): () => void {
    this.bus.on(deploymentId, listener);
    return () => this.bus.off(deploymentId, listener);
  }
}
