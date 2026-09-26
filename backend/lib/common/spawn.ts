import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called once per complete line of stdout or stderr. */
  onLine?: (line: string) => void;
  /** Aborting kills the child. */
  signal?: AbortSignal;
  /** Hard cap in milliseconds. */
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  /** Combined stdout+stderr, capped. For error messages, not for the log. */
  output: string;
}

export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly code: number,
    readonly output: string,
  ) {
    super(`${command} exited with code ${code}`);
    this.name = "CommandFailedError";
  }
}

export class CommandAbortedError extends Error {
  constructor(readonly command: string) {
    super(`${command} was cancelled`);
    this.name = "CommandAbortedError";
  }
}

/** Only the tail is kept for error messages; the full stream goes to the log. */
const MAX_CAPTURED = 16 * 1024;

/**
 * Runs a command, streaming its output line by line.
 *
 * Always `shell: false` with an argv array. Arguments here include values that
 * originate in a repository - a Dockerfile path, a build context - and with a
 * shell those become an injection vector. docker and git are real executables,
 * so no shell is needed to find them, even on Windows.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { cwd, env, onLine, signal, timeoutMs } = options;

  return new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CommandAbortedError(command));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      shell: false,
      windowsHide: true,
    });

    let captured = "";
    let settled = false;
    let aborted = false;
    let timedOut = false;

    // Line splitting has to be stateful: a chunk boundary lands mid-line often
    // enough that naive per-chunk splitting garbles build output. Each stream
    // gets its own buffer, and its own flush for the final unterminated line -
    // which is common, since plenty of tools do not end with a newline.
    const makeSink = () => {
      let buffer = "";
      const write = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (captured.length < MAX_CAPTURED) {
          captured += text.slice(0, MAX_CAPTURED - captured.length);
        }
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          onLine?.(line);
        }
      };
      const flush = () => {
        if (buffer) {
          onLine?.(buffer);
          buffer = "";
        }
      };
      return { write, flush };
    };

    const flushers: Array<() => void> = [];
    for (const stream of [child.stdout, child.stderr]) {
      const sink = makeSink();
      stream?.on("data", sink.write);
      flushers.push(sink.flush);
    }

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : undefined;

    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // ENOENT here means the binary is missing, which deserves a better
      // message than "spawn docker ENOENT".
      const message =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `"${command}" was not found on PATH. Is it installed and is the daemon running?`
          : error.message;
      reject(new Error(message));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      for (const flush of flushers) flush();

      if (aborted) {
        reject(new CommandAbortedError(command));
        return;
      }
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new CommandFailedError(command, code ?? -1, captured));
        return;
      }
      resolve({ code: 0, output: captured });
    });
  });
}
