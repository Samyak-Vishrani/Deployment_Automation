import { spawn } from "node:child_process";
import type { RuntimeLogLine } from "@orbitops/integration-common/contract";
import { ProviderError } from "@orbitops/integration-common/provider-error";
import { redact } from "@orbitops/integration-common/redact";
import { toRenderRuntimeLines, type RenderLogPage } from "../providers/render-runtime";
import { CONTAINER_NAME, toDockerLine, type Spawner } from "./docker-tail";
import type { ProxyClient } from "./proxy-client";

export interface Snapshot {
  lines: RuntimeLogLine[];
  note: string | null;
}

/**
 * A running component's recent runtime lines, once (Phase 13, for the AI):
 * not a live stream, not counted against the per-user stream limit.
 *
 * - Render: one newest-first /v1/logs page through render_integration's
 *   proxy (one read of Render's 30-a-minute limit), shown oldest first.
 * - Vercel: none. Vercel's runtime-log endpoint only streams new lines and
 *   keeps no history it will return (measured in Phase 12).
 */
export async function renderSnapshot(
  proxy: Pick<ProxyClient, "renderLogs">,
  userId: string,
  componentId: string,
  options: { sinceMs: number; limit: number; signal: AbortSignal; now?: () => number },
): Promise<Snapshot> {
  const now = options.now ?? Date.now;
  const { page } = await proxy.renderLogs(
    userId,
    componentId,
    { types: ["app"], startTime: new Date(now() - options.sinceMs).toISOString(), limit: Math.min(Math.max(1, options.limit), 100), direction: "backward" },
    options.signal,
  );
  const body = (page ?? {}) as RenderLogPage;
  const lines = toRenderRuntimeLines(body, { includeRequests: false })
    .sort((a, b) => a.at - b.at)
    .map((l) => ({ ...l, text: redact(l.text) }));
  return { lines, note: lines.length === 0 ? "No app log lines in this window." : body.hasMore ? "Only the latest lines of the window." : null };
}

export const VERCEL_SNAPSHOT: Snapshot = {
  lines: [],
  note: "Vercel keeps no runtime-log history to read back; only live tails (Logs page → Runtime) show function logs.",
};

/** The local container's last `limit` lines (`docker logs --tail`), the container need not be running. */
export function dockerSnapshot(containerName: string, options: { sinceMs: number; limit: number; spawner?: Spawner; timeoutMs?: number }): Promise<Snapshot> {
  if (!CONTAINER_NAME.test(containerName)) return Promise.reject(new ProviderError("Not an OrbitOps container name.", 400, "bad_request"));
  const run = options.spawner ?? spawn;
  return new Promise((resolve, reject) => {
    const child = run(
      "docker",
      ["logs", "--timestamps", "--tail", String(Math.min(Math.max(1, options.limit), 500)), "--since", `${Math.max(1, Math.round(options.sinceMs / 1000))}s`, containerName],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const out: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
    child.stdout?.on("data", (d: Buffer) => out.push({ stream: "stdout", text: d.toString("utf8") }));
    child.stderr?.on("data", (d: Buffer) => out.push({ stream: "stderr", text: d.toString("utf8") }));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 10_000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new ProviderError("Docker is not reachable. Is Docker Desktop running?", 503, "docker_unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const errText = out.filter((o) => o.stream === "stderr").map((o) => o.text).join("");
      if (code !== 0 && /No such container/i.test(errText)) {
        reject(new ProviderError(`${containerName} does not exist. Deploy the project first.`, 404, "not_running"));
        return;
      }
      let serial = 0;
      const lines = out
        .flatMap((o) => o.text.split("\n").map((t) => ({ stream: o.stream, t: t.replace(/\r$/, "") })))
        .map((x) => toDockerLine(x.t, x.stream, ++serial))
        .filter((l): l is RuntimeLogLine => Boolean(l))
        .sort((a, b) => a.at - b.at)
        .map((l) => ({ ...l, text: redact(l.text) }));
      resolve({ lines, note: lines.length === 0 ? "The container logged nothing in this window." : null });
    });
  });
}
