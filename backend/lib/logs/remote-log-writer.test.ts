import { describe, expect, it, vi } from "vitest";
import type { AppendBatch } from "./logs-service.client";
import { RemoteLogWriter } from "./remote-log-writer";
import { ProviderLogSink } from "@/lib/providers/provider-log-sink";
import { RemoteLogs } from "./remote-logs";

const ids = { deploymentId: "d1", projectId: "p1", componentId: "c1", provider: "render" };

/** A fake logs service that can be switched off, and dedupes by clientSeq like the real one. */
function fakeService() {
  const stored: AppendBatch["entries"] = [];
  let last = 0;
  const state = { up: true, closed: null as string | null };
  const client = {
    append: vi.fn(async (_id: string, batch: AppendBatch) => {
      if (!state.up) throw new Error("connection refused");
      batch.entries.forEach((entry, i) => {
        if (batch.clientSeq + i > last) stored.push(entry);
      });
      last = Math.max(last, batch.clientSeq + batch.entries.length - 1);
      return { nextSeq: stored.length + 1, accepted: batch.entries.length };
    }),
    close: vi.fn(async (_id: string, _projectId: string, status: string) => {
      if (!state.up) throw new Error("connection refused");
      state.closed = status;
      return { tail: "service tail" };
    }),
  };
  return { client, stored, state };
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("RemoteLogWriter", () => {
  it("redacts, tags and sends lines in batches numbered by clientSeq", async () => {
    const svc = fakeService();
    const writer = new RemoteLogWriter(svc.client, ids, { secrets: ["s3cret-value"], defaultSource: "render", flushMs: 5 });
    writer.write("token s3cret-value here");
    writer.section("Deploying");
    writer.write("app line", { phase: "runtime", stream: "stderr", at: 42 });
    await until(() => svc.stored.length === 3);

    expect(svc.client.append).toHaveBeenCalledTimes(1);
    expect(svc.client.append.mock.calls[0][1]).toMatchObject({ projectId: "p1", componentId: "c1", provider: "render", clientSeq: 1 });
    expect(svc.stored).toEqual([
      { text: "token ***REDACTED*** here", at: expect.any(Number), source: "render", phase: "build", stream: "stdout" },
      { text: "==> Deploying", at: expect.any(Number), source: "orbitops", phase: "setup", stream: "info" },
      { text: "app line", at: 42, source: "render", phase: "runtime", stream: "stderr" },
    ]);
    expect(writer.tailText()).toMatch(/\[render\] token \*\*\*REDACTED\*\*\* here/);
  });

  it("retries while the service is down, then delivers everything once", async () => {
    const svc = fakeService();
    svc.state.up = false;
    const writer = new RemoteLogWriter(svc.client, ids, { flushMs: 2, maxRetryMs: 10 });
    writer.write("a");
    writer.write("b");
    await until(() => svc.client.append.mock.calls.length >= 2);
    svc.state.up = true;
    await until(() => writer.pending === 0);
    expect(svc.stored.map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("drops the oldest beyond the buffer and says how many were lost", async () => {
    const svc = fakeService();
    svc.state.up = false;
    const writer = new RemoteLogWriter(svc.client, ids, { flushMs: 2, maxRetryMs: 5, maxBuffered: 3 });
    for (const t of ["1", "2", "3", "4", "5"]) writer.write(t);
    await writer.flush();
    svc.state.up = true;
    await until(() => writer.pending === 0 && svc.stored.length >= 4);
    expect(svc.stored.map((e) => e.text)).toEqual(["3", "4", "5", "2 log lines were lost while the logs service was unavailable."]);
  });

  it("closes through the service and returns its tail", async () => {
    const svc = fakeService();
    const writer = new RemoteLogWriter(svc.client, ids, { flushMs: 1000 });
    writer.write("last line");
    await expect(writer.close("success")).resolves.toBe("service tail");
    expect(svc.stored.map((e) => e.text)).toEqual(["last line"]);
    expect(svc.state.closed).toBe("success");
  });

  it("returns its own tail when the service is down at close, and delivers and closes later", async () => {
    const svc = fakeService();
    svc.state.up = false;
    const writer = new RemoteLogWriter(svc.client, ids, { flushMs: 1, maxRetryMs: 5, closeWaitMs: 20 });
    writer.write("built");
    const tail = await writer.close("failed");
    expect(tail).toMatch(/\] \[orbitops\] built\n$/);
    expect(svc.state.closed).toBeNull();
    svc.state.up = true;
    await until(() => svc.state.closed === "failed", 5000);
    expect(svc.stored.map((e) => e.text)).toEqual(["built"]);
  });
});

describe("ProviderLogSink", () => {
  it("files a deployment's lines with its component and provider, OrbitOps lines as orbitops", async () => {
    const svc = fakeService();
    const logs = new RemoteLogs({ ...svc.client, entries: vi.fn(), text: vi.fn(), openBuildStream: vi.fn() }, { flushMs: 1 });
    const sink = new ProviderLogSink(logs, async () => ({ componentId: "c1", provider: "vercel" }));
    await sink.write("p1", "d1", ["Environment: A, B (secret)."]);
    await sink.write("p1", "d1", [{ text: "compiled", at: 3, stream: "stdout", source: "vercel", phase: "build" }]);
    await sink.addSecrets("p1", "d1", ["tok_abcdef123"]);
    await sink.write("p1", "d1", [{ text: "leaked tok_abcdef123", source: "vercel" }]);
    const tail = await sink.close("p1", "d1", "success");

    expect(tail).toBe("service tail");
    expect(svc.client.append.mock.calls[0][1]).toMatchObject({ componentId: "c1", provider: "vercel" });
    expect(svc.stored).toEqual([
      { text: "Environment: A, B (secret).", at: expect.any(Number), source: "orbitops", phase: "deploy", stream: "info" },
      { text: "compiled", at: 3, source: "vercel", phase: "build", stream: "stdout" },
      { text: "leaked ***REDACTED***", at: expect.any(Number), source: "vercel", phase: "build", stream: "stdout" },
    ]);
  });
});
