import { EventEmitter } from "node:events";
import type { LogEntry } from "@orbitops/integration-common/contract";
import { describe, expect, it, vi } from "vitest";
import { excerpt } from "./entries/excerpt";
import type { Spawner } from "./runtime/docker-tail";
import { dockerSnapshot, renderSnapshot, VERCEL_SNAPSHOT } from "./runtime/snapshot";

const entry = (seq: number, text: string, stream: LogEntry["stream"] = "stdout"): LogEntry => ({ seq, at: seq * 1000, source: "render", phase: "build", stream, text });

describe("excerpt (Phase 13)", () => {
  it("keeps head, tail and each error with its context, collapsing repeats", () => {
    const entries = Array.from({ length: 1000 }, (_, i) => entry(i + 1, `progress ${i + 1}`));
    entries[499] = entry(500, "Error: boom", "stderr");
    for (let i = 600; i < 610; i++) entries[i] = entry(i + 1, "retrying...");
    const out = excerpt(entries, { maxLines: 400 });
    const seqs = out.entries.map((e) => e.seq);
    expect(seqs.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(seqs).toContain(500);
    expect(seqs).toEqual(expect.arrayContaining([495, 505]));
    expect(seqs.at(-1)).toBe(1000);
    expect(out).toMatchObject({ totalLines: 1000, errorLines: 1, truncated: true });
    expect(out.entries.length).toBeLessThanOrEqual(400);
  });

  it("collapses a run of identical lines into one with repeat", () => {
    const entries = [entry(1, "a"), ...Array.from({ length: 5 }, (_, i) => entry(i + 2, "same")), entry(7, "b")];
    const out = excerpt(entries);
    expect(out.entries.map((e) => [e.seq, e.text, e.repeat ?? 1])).toEqual([
      [1, "a", 1],
      [2, "same", 5],
      [7, "b", 1],
    ]);
    expect(out.truncated).toBe(false);
  });

  it("narrows to error lines when even the narrow cut is too long", () => {
    const entries = Array.from({ length: 3000 }, (_, i) => entry(i + 1, i % 3 === 0 ? `Error: e${i}` : `ok ${i}`, i % 3 === 0 ? "stderr" : "stdout"));
    const out = excerpt(entries, { maxLines: 100 });
    expect(out.entries).toHaveLength(100);
    expect(out.entries.every((e) => e.text.startsWith("Error:"))).toBe(true);
  });
});

describe("runtime snapshots (Phase 13)", () => {
  it("reads one newest-first Render page and returns it oldest first, redacted", async () => {
    const proxy = {
      renderLogs: vi.fn(async (_u: string, _c: string, _q: { direction?: string; startTime?: string }) => ({
        page: {
          hasMore: true,
          logs: [
            { id: "b", message: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB", timestamp: "2026-11-20T10:00:02Z", labels: [{ name: "type", value: "app" }] },
            { id: "a", message: "listening", timestamp: "2026-11-20T10:00:01Z", labels: [{ name: "type", value: "app" }] },
          ],
        },
        remaining: 20,
        resetMs: 1000,
      })),
    };
    const snap = await renderSnapshot(proxy, "u1", "c1", { sinceMs: 3_600_000, limit: 100, signal: new AbortController().signal, now: () => Date.parse("2026-11-20T11:00:00Z") });
    expect(proxy.renderLogs.mock.calls[0][2]).toMatchObject({ types: ["app"], direction: "backward", startTime: "2026-11-20T10:00:00.000Z" });
    expect(snap.lines.map((l) => l.id)).toEqual(["a", "b"]);
    expect(snap.lines[1].text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
    expect(snap.note).toMatch(/latest lines/);
    expect(VERCEL_SNAPSHOT.lines).toEqual([]);
  });

  it("reads the Docker container's tail, and reports a missing container", async () => {
    const spawner = ((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      setImmediate(() => {
        if (args.at(-1) === "orbitops-gone") {
          child.stderr.emit("data", Buffer.from("Error response from daemon: No such container: orbitops-gone\n"));
          child.emit("close", 1);
          return;
        }
        expect(args).toEqual(expect.arrayContaining(["logs", "--tail", "50"]));
        child.stdout.emit("data", Buffer.from("2026-11-20T10:00:01Z started\n"));
        child.stderr.emit("data", Buffer.from("2026-11-20T10:00:02Z boom\n"));
        child.emit("close", 0);
      });
      return child;
    }) as unknown as Spawner;
    const snap = await dockerSnapshot("orbitops-shop", { sinceMs: 60_000, limit: 50, spawner });
    expect(snap.lines.map((l) => [l.text, l.stream])).toEqual([
      ["started", "stdout"],
      ["boom", "stderr"],
    ]);
    await expect(dockerSnapshot("orbitops-gone", { sinceMs: 60_000, limit: 50, spawner })).rejects.toMatchObject({ code: "not_running" });
    await expect(dockerSnapshot("postgres", { sinceMs: 1, limit: 1, spawner })).rejects.toMatchObject({ status: 400 });
  });
});
