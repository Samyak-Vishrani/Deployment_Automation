import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeLogEvent } from "@orbitops/integration-common/contract";
import { ProviderError } from "@orbitops/integration-common/provider-error";
import { describe, expect, it, vi } from "vitest";
import { tailDocker, toDockerLine, type Spawner } from "./docker-tail";
import { ProxyClient } from "./proxy-client";
import { pacing, tailRender } from "./render-tail";
import { RuntimeSessions } from "./runtime-session";
import { tailVercel } from "./vercel-tail";

const collect = async (gen: AsyncGenerator<RuntimeLogEvent>, max = 50) => {
  const out: RuntimeLogEvent[] = [];
  for await (const e of gen) {
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
};
const texts = (events: RuntimeLogEvent[]) => events.flatMap((e) => (e.type === "line" ? [e.line.text] : []));
const entry = (id: string, at: string, message: string, type = "app") => ({ id, message, timestamp: at, labels: [{ name: "type", value: type }] });

describe("tailRender", () => {
  const T = (s: number) => new Date(Date.UTC(2026, 10, 4, 10, 0, s)).toISOString();

  it("backfills the newest lines first, then polls forward from the newest, de-duplicating overlap", async () => {
    const abort = new AbortController();
    const calls: Array<{ startTime: string; direction?: string }> = [];
    const pages: Array<() => unknown> = [
      // backward: newest first
      () => ({ logs: [entry("b", T(1), "second"), entry("a", T(0), "first")], hasMore: false }),
      () => ({ logs: [entry("b", T(1), "second"), entry("c", T(5), "third")], hasMore: false }),
      () => {
        abort.abort();
        return { logs: [] };
      },
    ];
    const proxy = {
      renderLogs: vi.fn(async (_u: string, _c: string, q: { startTime: string; direction?: "forward" | "backward" }) => {
        calls.push(q);
        return { page: pages.shift()!(), remaining: 25, resetMs: 30_000 };
      }),
    };
    const sleeps: number[] = [];
    const events = await collect(
      tailRender(proxy, "u1", "c1", {
        sinceMs: 15 * 60_000,
        includeRequests: false,
        pollMs: 3000,
        signal: abort.signal,
        sleep: async (ms) => void sleeps.push(ms),
        now: () => Date.parse("2026-11-04T10:15:00Z"),
      }),
    );
    expect(texts(events)).toEqual(["first", "second", "third"]);
    expect(calls[0]).toMatchObject({ startTime: "2026-11-04T10:00:00.000Z", direction: "backward" });
    expect(calls[1]).toMatchObject({ startTime: T(1), direction: "forward" });
    expect(sleeps).toEqual([3000, 3000]);
  });

  it("waits for the rate-limit reset when Render's quota is nearly spent, and slows down on a 429", async () => {
    const abort = new AbortController();
    const results: Array<() => { page: unknown; remaining: number | null; resetMs: number | null }> = [
      () => ({ page: { logs: [] }, remaining: 2, resetMs: 40_000 }),
      () => {
        throw Object.assign(new ProviderError("slow down", 429, "render_rate_limited"), { retryAfterMs: 12_000 });
      },
      () => {
        abort.abort();
        return { page: { logs: [] }, remaining: 20, resetMs: 1000 };
      },
    ];
    const proxy = { renderLogs: vi.fn(async () => results.shift()!()) };
    const sleeps: number[] = [];
    const events = await collect(
      tailRender(proxy, "u1", "c1", { sinceMs: 60_000, includeRequests: false, pollMs: 3000, signal: abort.signal, sleep: async (ms) => void sleeps.push(ms) }),
    );
    expect(sleeps).toEqual([40_000, 12_000]);
    expect(events.some((e) => e.type === "notice" && /rate-limited/.test(e.text))).toBe(true);
  });

  it("retries a transient failure with a notice, and gives up after five in a row", async () => {
    const proxy = {
      renderLogs: vi.fn(async (_u: string, _c: string, q: { direction?: string }) => {
        if (q.direction === "backward") return { page: { logs: [] }, remaining: null, resetMs: null };
        throw new ProviderError("Could not reach Render (fetch failed).", 502, "render_unavailable", { retryable: true });
      }),
    };
    const sleeps: number[] = [];
    const run = collect(
      tailRender(proxy, "u1", "c1", { sinceMs: 60_000, includeRequests: true, pollMs: 1000, signal: new AbortController().signal, sleep: async (ms) => void sleeps.push(ms) }),
    );
    await expect(run).rejects.toMatchObject({ code: "render_unavailable" });
    expect(proxy.renderLogs.mock.calls[0][2]).toMatchObject({ types: ["app", "request"] });
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it("ends at once on a refusal that will not go away", async () => {
    const proxy = {
      renderLogs: vi.fn(async (_u: string, _c: string, q: { direction?: string }) => {
        if (q.direction === "backward") return { page: { logs: [] }, remaining: null, resetMs: null };
        throw new ProviderError("Render rejected the saved API key.", 412, "render_key_invalid");
      }),
    };
    await expect(
      collect(tailRender(proxy, "u1", "c1", { sinceMs: 60_000, includeRequests: false, pollMs: 1, signal: new AbortController().signal, sleep: async () => undefined })),
    ).rejects.toMatchObject({ code: "render_key_invalid" });
    expect(pacing(3000, 2, 50_000)).toBe(50_000);
    expect(pacing(3000, 10, 50_000)).toBe(3000);
  });
});

describe("tailVercel", () => {
  const body = (...chunks: string[]) =>
    (async function* () {
      for (const c of chunks) yield new TextEncoder().encode(c);
    })();

  it("reads the stream across odd chunk boundaries and reconnects quietly, skipping rows already shown", async () => {
    const abort = new AbortController();
    const fixture = readFileSync(join(__dirname, "..", "providers", "__fixtures__", "vercel-runtime.ndjson"), "utf8");
    const streams = [body(fixture.slice(0, 50), fixture.slice(50, 333), fixture.slice(333)), body(fixture.split("\n")[0] + "\n")];
    const proxy = {
      vercelRuntime: vi.fn(async () => {
        const next = streams.shift();
        if (!next) {
          abort.abort();
          throw new Error("aborted");
        }
        return { body: next, deploymentId: "dpl_1" };
      }),
    };
    const events = await collect(tailVercel(proxy, "u1", "c1", { signal: abort.signal, sleep: async () => undefined }));
    expect(texts(events)).toEqual([
      "GET /api/hello",
      "hello from the function",
      "TypeError: cannot read properties of undefined …(truncated by Vercel)",
    ]);
    expect(proxy.vercelRuntime).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
  });

  it("reports connected without waiting for Vercel's first line, but a quick refusal is an error", async () => {
    const abort = new AbortController();
    const never = { vercelRuntime: vi.fn(() => new Promise<never>(() => undefined)) };
    const gen = tailVercel(never, "u1", "c1", { signal: abort.signal, quickFailMs: 20 });
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: "notice", text: expect.stringContaining("Connected to Vercel") });
    abort.abort();
    await gen.return(undefined);

    const refused = {
      vercelRuntime: vi.fn(async () => {
        throw new ProviderError("Nothing of web is live on Vercel yet.", 404, "not_deployed");
      }),
    };
    await expect(collect(tailVercel(refused, "u1", "c1", { signal: new AbortController().signal, quickFailMs: 1000 }))).rejects.toMatchObject({
      code: "not_deployed",
    });
  });
});

describe("ProxyClient", () => {
  it("sends the logs-proxy token and maps the service's errors and outages", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>)["x-logs-token"]).toBe("proxy-token");
      return new Response(JSON.stringify({ error: "not_deployed", message: "api is not on Render yet." }), { status: 404 });
    }) as unknown as typeof fetch;
    const client = new ProxyClient({ vercelUrl: "http://v", renderUrl: "http://r", token: "proxy-token", fetchImpl });
    await expect(client.renderLogs("u1", "c1", { types: ["app"], startTime: "t" }, new AbortController().signal)).rejects.toMatchObject({
      status: 404,
      code: "not_deployed",
    });

    const down = new ProxyClient({ vercelUrl: "http://v", renderUrl: "http://r", token: "x", fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    await expect(down.vercelRuntime("u1", "c1", new AbortController().signal)).rejects.toMatchObject({ status: 503, code: "vercel_service_unavailable" });
  });
});

describe("tailDocker", () => {
  function fakeSpawner(inspect: { code: number; out: string }, lines: Array<[("stdout" | "stderr"), string]>) {
    const killed = { value: false };
    const spawner = ((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        killed.value = true;
        setImmediate(() => child.emit("close", 0));
      };
      setImmediate(() => {
        if (args[0] === "inspect") {
          child.stdout.emit("data", Buffer.from(inspect.out));
          child.emit("close", inspect.code);
        } else {
          for (const [stream, text] of lines) child[stream].emit("data", Buffer.from(text));
        }
      });
      return child;
    }) as unknown as Spawner;
    return { spawner, killed };
  }

  it("follows the container, splits stdout and stderr, and kills docker when the viewer leaves", async () => {
    const { spawner, killed } = fakeSpawner({ code: 0, out: "true\n" }, [
      ["stdout", "2026-11-04T10:00:00.123456789Z listening on 3000\n2026-11-04T10:00:01Z GET / 200\n"],
      ["stderr", "2026-11-04T10:00:02Z boom\n"],
    ]);
    const abort = new AbortController();
    const events: RuntimeLogEvent[] = [];
    for await (const e of tailDocker("orbitops-shop", { sinceMs: 60_000, signal: abort.signal, spawner })) {
      events.push(e);
      if (texts(events).length === 3) abort.abort();
    }
    expect(texts(events)).toEqual(["listening on 3000", "GET / 200", "boom"]);
    expect(events.find((e) => e.type === "line" && e.line.text === "boom")).toMatchObject({ line: { stream: "stderr" } });
    expect(killed.value).toBe(true);
  });

  it("refuses a stopped container and a name that is not ours", async () => {
    const { spawner } = fakeSpawner({ code: 1, out: "" }, []);
    await expect(collect(tailDocker("orbitops-shop", { sinceMs: 1, signal: new AbortController().signal, spawner }))).rejects.toMatchObject({ code: "not_running" });
    await expect(collect(tailDocker("postgres", { sinceMs: 1, signal: new AbortController().signal, spawner }))).rejects.toMatchObject({ status: 400 });
    expect(toDockerLine("no timestamp", "stdout", 1)).toMatchObject({ text: "no timestamp" });
  });
});

describe("RuntimeSessions", () => {
  const forever = (onAbort?: () => void) =>
    async function* (signal: AbortSignal): AsyncGenerator<RuntimeLogEvent> {
      yield { type: "notice", text: "connected" };
      if (!signal.aborted) await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      onAbort?.();
    };

  it("allows N streams per user and frees a slot when one ends", async () => {
    const sessions = new RuntimeSessions({ maxPerUser: 2, maxMs: 60_000, idleMs: 60_000 });
    const a = await sessions.open("u1", forever());
    await sessions.open("u1", forever());
    await expect(sessions.open("u1", forever())).rejects.toMatchObject({ status: 409, code: "runtime_logs_busy" });
    await sessions.open("u2", forever());
    a.abort();
    await collect(a.events);
    await expect(sessions.open("u1", forever())).resolves.toBeTruthy();
    sessions.closeAll();
  });

  it("ends an unwatched stream as idle, and a ping keeps it alive", async () => {
    vi.useFakeTimers();
    try {
      const sessions = new RuntimeSessions({ maxPerUser: 3, maxMs: 60 * 60_000, idleMs: 1000 });
      let stopped = false;
      const session = await sessions.open("u1", forever(() => (stopped = true)));
      const run = collect(session.events);
      await vi.advanceTimersByTimeAsync(800);
      expect(sessions.ping(session.sessionId)).toBe(true);
      await vi.advanceTimersByTimeAsync(800);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      const events = await run;
      expect(stopped).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "end", reason: "idle" });
      expect(sessions.ping(session.sessionId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends at the maximum length, and reports a tailer failure after the start as an error end", async () => {
    vi.useFakeTimers();
    try {
      const sessions = new RuntimeSessions({ maxPerUser: 3, maxMs: 1000, idleMs: 60_000 });
      const run = collect((await sessions.open("u1", forever())).events);
      await vi.advanceTimersByTimeAsync(1100);
      expect((await run).at(-1)).toMatchObject({ type: "end", reason: "max_duration" });
    } finally {
      vi.useRealTimers();
    }
    const sessions = new RuntimeSessions({ maxPerUser: 3, maxMs: 60_000, idleMs: 60_000 });
    const failing = await sessions.open("u1", async function* () {
      yield { type: "notice", text: "connected" };
      throw new ProviderError("Render rejected the saved API key.", 412, "render_key_invalid");
    });
    expect((await collect(failing.events)).at(-1)).toEqual({ type: "end", reason: "error", message: "Render rejected the saved API key." });
  });
});
