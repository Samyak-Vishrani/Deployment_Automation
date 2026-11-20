import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { RuntimeLogEvent } from "@orbitops/integration-common/contract";
import { readNdjson } from "@orbitops/integration-common/ndjson";
import { ProviderError } from "@orbitops/integration-common/provider-error";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { buildLogStream } from "./routes/build-stream";
import { RuntimeSessions } from "./runtime/runtime-session";
import { LogStore } from "./store/log-store";

const TOKEN = "t".repeat(40);
const headers = { "x-internal-token": TOKEN, "content-type": "application/json" };
let dir: string;
let store: LogStore;
let app: FastifyInstance;
let sessions: RuntimeSessions;
let tail: (signal: AbortSignal) => AsyncGenerator<RuntimeLogEvent>;

const entries = (...texts: string[]) => texts.map((text) => ({ text, source: "vercel", phase: "build", stream: "stdout", at: 1 }));
const ingest = (clientSeq: number, ...texts: string[]) =>
  app.inject({ method: "POST", url: "/deployments/d1/entries", headers, payload: { projectId: "p1", componentId: "c1", provider: "vercel", clientSeq, entries: entries(...texts) } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbitops-logs-app-"));
  store = new LogStore({ dataDir: join(dir, "data"), legacyDir: join(dir, "legacy"), maxLogBytes: 1e9 });
  sessions = new RuntimeSessions({ maxPerUser: 2, maxMs: 60_000, idleMs: 60_000 });
  tail = async function* () {
    yield { type: "notice", text: "connected" } as RuntimeLogEvent;
    yield { type: "line", line: { id: "1", at: 1, stream: "stdout", text: "hello ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" } } as RuntimeLogEvent;
  };
  app = buildApp({
    serviceToken: TOKEN,
    store,
    heartbeatMs: 60_000,
    runtime: {
      sessions,
      tailers: {
        vercel: (_u, _c, signal) => tail(signal),
        render: (_u, _c, _o, signal) => tail(signal),
        docker: (_n, _o, signal) => tail(signal),
      },
    },
  });
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function listen(): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

describe("auth", () => {
  it("needs the internal token everywhere but /health", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/deployments/d1/entries?projectId=p1" });
    expect(res.statusCode).toBe(401);
  });
});

describe("build-log routes", () => {
  it("ingests, reads after a seq, renders text and closes with the tail", async () => {
    expect((await ingest(1, "one", "two")).json()).toEqual({ nextSeq: 3, accepted: 2 });
    expect((await ingest(1, "one", "two")).json()).toEqual({ nextSeq: 3, accepted: 0 });

    const read = await app.inject({ method: "GET", url: "/deployments/d1/entries?projectId=p1&afterSeq=1", headers });
    expect(read.json()).toMatchObject({ entries: [{ seq: 2, text: "two", source: "vercel" }], complete: false });

    const text = await app.inject({ method: "GET", url: "/deployments/d1/text?projectId=p1", headers });
    expect(text.headers["content-type"]).toMatch(/text\/plain/);
    expect(text.body).toBe("[00:00:00] [vercel] one\n[00:00:00] [vercel] two\n");

    const closed = await app.inject({ method: "POST", url: "/deployments/d1/close", headers, payload: { projectId: "p1", status: "success" } });
    expect(closed.json().tail).toContain("[vercel] two");
  });

  it("answers 400 for a bad batch or id, without echoing the text", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/deployments/d1/entries",
      headers,
      payload: { projectId: "p1", provider: "vercel", clientSeq: 1, entries: [{ text: "secret-ish", source: "nope", phase: "build", stream: "stdout" }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("secret-ish");
    expect((await app.inject({ method: "GET", url: "/deployments/d1/entries?projectId=..%2F..", headers })).statusCode).toBe(400);
    expect((await ingest(0, "x")).statusCode).toBe(400);
  });

  it("streams a finished log as NDJSON entries, then done", async () => {
    await ingest(1, "a", "b");
    await store.close("d1", "p1", "failed");
    const base = await listen();
    const res = await fetch(`${base}/deployments/d1/stream?projectId=p1&afterSeq=1`, { headers });
    expect(res.headers.get("content-type")).toMatch(/x-ndjson/);
    const items: unknown[] = [];
    for await (const item of readNdjson(res.body as unknown as AsyncIterable<Uint8Array>)) items.push(item);
    expect(items).toEqual([
      { type: "entry", entry: expect.objectContaining({ seq: 2, text: "b" }) },
      { type: "done", status: "failed" },
    ]);
  });
});

describe("buildLogStream", () => {
  it("delivers a line written during the replay exactly once, in order, then live lines and done", async () => {
    await store.append("d1", { projectId: "p1", componentId: null, provider: "render", clientSeq: 1, entries: entries("1", "2") as never });
    // Write a line while the replay is being read: the race the old route lost lines to.
    const racing = {
      read: async (...args: Parameters<LogStore["read"]>) => {
        const result = await store.read(...args);
        if (args[2]?.afterSeq === 0) {
          await store.append("d1", { projectId: "p1", componentId: null, provider: "render", clientSeq: 3, entries: entries("3") as never });
        }
        return result;
      },
      subscribe: store.subscribe.bind(store),
    };
    const abort = new AbortController();
    const seen: string[] = [];
    const run = (async () => {
      for await (const item of buildLogStream(racing, "d1", "p1", 0, abort.signal)) {
        seen.push(item.type === "entry" ? `${item.entry.seq}:${item.entry.text}` : `done:${item.status}`);
      }
    })();
    await new Promise((r) => setTimeout(r, 20));
    await store.append("d1", { projectId: "p1", componentId: null, provider: "render", clientSeq: 4, entries: entries("4") as never });
    await store.close("d1", "p1", "success");
    await run;
    expect(seen).toEqual(["1:1", "2:2", "3:3", "4:4", "done:success"]);
  });

  it("stops when the viewer leaves", async () => {
    const abort = new AbortController();
    const run = (async () => {
      const out: unknown[] = [];
      for await (const item of buildLogStream(store, "d9", "p1", 0, abort.signal)) out.push(item);
      return out;
    })();
    setTimeout(() => abort.abort(), 20);
    expect(await run).toEqual([]);
  });
});

describe("runtime routes", () => {
  it("streams events with a session id, redacts token shapes, and pings while open", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    tail = async function* () {
      yield { type: "notice", text: "connected" } as RuntimeLogEvent;
      yield { type: "line", line: { id: "1", at: 1, stream: "stdout", text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" } } as RuntimeLogEvent;
      await hold;
    };
    const base = await listen();
    const res = await fetch(`${base}/runtime/components/c1/stream?userId=u1&provider=render&since=5m`, { headers });
    const sessionId = res.headers.get("x-session-id")!;
    expect(sessionId).toBeTruthy();
    expect((await app.inject({ method: "POST", url: `/runtime/sessions/${sessionId}/ping`, headers, payload: {} })).statusCode).toBe(200);
    release();
    const items: RuntimeLogEvent[] = [];
    for await (const item of readNdjson<RuntimeLogEvent>(res.body as unknown as AsyncIterable<Uint8Array>)) items.push(item);
    expect(items[0]).toEqual({ type: "notice", text: "connected" });
    expect(JSON.stringify(items)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
    expect(items.at(-1)).toMatchObject({ type: "end", reason: "upstream_closed" });
    expect((await app.inject({ method: "POST", url: `/runtime/sessions/${sessionId}/ping`, headers, payload: {} })).statusCode).toBe(404);
  });

  it("turns a refusal before the first event into an HTTP error", async () => {
    tail = async function* () {
      throw new ProviderError("Nothing of web is live on Vercel yet.", 404, "not_deployed");
    };
    const res = await app.inject({ method: "GET", url: "/runtime/components/c1/stream?userId=u1&provider=vercel", headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_deployed", message: "Nothing of web is live on Vercel yet." });
    expect(sessions.openCount).toBe(0);
  });

  it("validates provider and since", async () => {
    expect((await app.inject({ method: "GET", url: "/runtime/components/c1/stream?userId=u1&provider=neon", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/runtime/components/c1/stream?userId=u1&provider=render&since=9y", headers })).statusCode).toBe(400);
  });
});
