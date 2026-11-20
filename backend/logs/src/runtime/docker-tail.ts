import { spawn } from "node:child_process";
import type { RuntimeLogEvent, RuntimeLogLine } from "@orbitops/integration-common/contract";
import { ProviderError } from "@orbitops/integration-common/provider-error";

/** Containers OrbitOps runs for local Docker deploys: `orbitops-<slug>`. */
export const CONTAINER_NAME = /^orbitops-[a-z0-9-]{1,60}$/;

export type Spawner = typeof spawn;

/**
 * The local Docker container's logs, live: `docker logs --follow --timestamps`
 * stays running and prints each line as the container writes it. The child is
 * killed as soon as the viewer leaves.
 */
export async function* tailDocker(
  containerName: string,
  options: { sinceMs: number; signal: AbortSignal; spawner?: Spawner },
): AsyncGenerator<RuntimeLogEvent> {
  if (!CONTAINER_NAME.test(containerName)) throw new ProviderError("Not an OrbitOps container name.", 400, "bad_request");
  const run = options.spawner ?? spawn;

  const running = await new Promise<string>((resolve) => {
    const child = run("docker", ["inspect", "-f", "{{.State.Running}}", containerName], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve("no-docker"));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : "missing"));
  });
  if (running === "no-docker") throw new ProviderError("Docker is not reachable. Is Docker Desktop running?", 503, "docker_unavailable");
  if (running !== "true") throw new ProviderError(`${containerName} is not running. Deploy the project first.`, 404, "not_running");

  const child = run(
    "docker",
    ["logs", "--follow", "--timestamps", "--since", `${Math.max(1, Math.round(options.sinceMs / 1000))}s`, containerName],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const queue: RuntimeLogLine[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  let serial = 0;
  const feed = (stream: "stdout" | "stderr") => {
    let buffer = "";
    return (data: Buffer) => {
      buffer += data.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        const line = toDockerLine(raw, stream, ++serial);
        if (line) queue.push(line);
      }
      wake?.();
    };
  };
  child.stdout?.on("data", feed("stdout"));
  child.stderr?.on("data", feed("stderr"));
  child.on("close", () => {
    ended = true;
    wake?.();
  });
  const kill = () => child.kill();
  options.signal.addEventListener("abort", kill, { once: true });

  try {
    yield { type: "notice", text: `Following ${containerName}.` };
    while (!options.signal.aborted) {
      while (queue.length > 0) yield { type: "line", line: queue.shift()! };
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      wake = null;
    }
  } finally {
    options.signal.removeEventListener("abort", kill);
    if (!ended) child.kill();
  }
}

/** `2026-11-04T10:00:00.123456789Z message` → a runtime line. */
export function toDockerLine(raw: string, stream: "stdout" | "stderr", serial: number): RuntimeLogLine | null {
  if (!raw.trim()) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s?(.*)$/.exec(raw);
  const at = match ? Date.parse(match[1]) : Date.now();
  const text = match ? match[2] : raw;
  if (!text.trim()) return null;
  return { id: `docker:${serial}`, at: Number.isFinite(at) ? at : Date.now(), stream, text };
}
