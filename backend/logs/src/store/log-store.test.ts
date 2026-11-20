import { mkdtemp, mkdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogStore, type IngestEntry, type StoreEvent } from "./log-store";

let dir: string;
let store: LogStore;

const line = (text: string, over: Partial<IngestEntry> = {}): IngestEntry => ({ text, source: "render", phase: "build", stream: "stdout", at: 1000, ...over });
const batch = (clientSeq: number, ...texts: string[]) => ({ projectId: "p1", componentId: "c1", provider: "render", clientSeq, entries: texts.map((t) => line(t)) });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbitops-logs-"));
  store = new LogStore({ dataDir: join(dir, "data"), legacyDir: join(dir, "legacy"), maxLogBytes: 20 * 1024 * 1024 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LogStore", () => {
  it("appends JSONL entries with a gap-free seq and reads them back after a seq", async () => {
    await store.append("d1", batch(1, "one", "two"));
    await store.append("d1", batch(3, "three"));

    const all = await store.read("d1", "p1");
    expect(all.entries.map((e) => [e.seq, e.text, e.source])).toEqual([
      [1, "one", "render"],
      [2, "two", "render"],
      [3, "three", "render"],
    ]);
    expect(all.complete).toBe(false);
    expect((await store.read("d1", "p1", { afterSeq: 2 })).entries.map((e) => e.text)).toEqual(["three"]);
    const page = await store.read("d1", "p1", { limit: 2 });
    expect(page).toMatchObject({ nextSeq: 2, complete: false });

    const file = await readFile(join(dir, "data", "p1", "d1.jsonl"), "utf8");
    expect(file.trim().split("\n")).toHaveLength(3);
  });

  it("drops a retried batch, so nothing is duplicated", async () => {
    await store.append("d1", batch(1, "a", "b"));
    const again = await store.append("d1", batch(1, "a", "b"));
    const overlap = await store.append("d1", batch(2, "b", "c"));
    expect(again.accepted).toBe(0);
    expect(overlap.accepted).toBe(1);
    expect((await store.read("d1", "p1")).entries.map((e) => e.text)).toEqual(["a", "b", "c"]);
  });

  it("continues seq after a restart, even when the meta file was lost", async () => {
    await store.append("d1", batch(1, "a", "b"));
    const fresh = new LogStore({ dataDir: join(dir, "data"), legacyDir: join(dir, "legacy"), maxLogBytes: 1e9 });
    await fresh.append("d1", batch(3, "c"));
    expect((await fresh.read("d1", "p1")).entries.map((e) => e.seq)).toEqual([1, 2, 3]);

    await unlink(join(dir, "data", "p1", "d1.meta.json"));
    const again = new LogStore({ dataDir: join(dir, "data"), legacyDir: join(dir, "legacy"), maxLogBytes: 1e9 });
    await again.append("d1", batch(1, "d"));
    expect((await again.read("d1", "p1")).entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("keeps concurrent appends in order", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append("d1", batch(i + 1, `line ${i}`))));
    const { entries } = await store.read("d1", "p1");
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(entries.map((e) => e.text)).size).toBe(20);
  });

  it("redacts token shapes as a backstop and cuts very long lines", async () => {
    await store.append("d1", { ...batch(1), entries: [line("token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"), line("x".repeat(20_000))] });
    const { entries } = await store.read("d1", "p1");
    expect(entries[0].text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
    expect(entries[1].text.length).toBeLessThan(17_000);
    expect(entries[1].text).toMatch(/line cut at 16 KB/);
  });

  it("stops at the size cap with exactly one truncation entry", async () => {
    const small = new LogStore({ dataDir: join(dir, "data"), legacyDir: join(dir, "legacy"), maxLogBytes: 600 });
    for (let i = 0; i < 10; i++) await small.append("d1", batch(i + 1, `line ${i} ${"y".repeat(50)}`));
    const { entries, truncated } = await small.read("d1", "p1");
    expect(truncated).toBe(true);
    expect(entries.filter((e) => /Log truncated/.test(e.text))).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({ source: "orbitops", stream: "info" });
  });

  it("emits live entries and done, and close returns the tail as text", async () => {
    const events: StoreEvent[] = [];
    const off = store.subscribe("d1", (e) => events.push(e));
    await store.append("d1", batch(1, "hello"));
    const { tail } = await store.close("d1", "p1", "success");
    off();
    expect(events.map((e) => e.type)).toEqual(["entry", "done"]);
    expect(tail).toMatch(/\[render\] hello\n$/);
    expect(await store.read("d1", "p1")).toMatchObject({ complete: true, status: "success" });
  });

  it("reads a pre-Phase-12 .log file read-only, as a finished log", async () => {
    const legacy = join(dir, "legacy", "p1");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "old.log"), "[10:00:00] ==> Deploying\n[10:00:01] built\n");
    const day = new Date(Date.UTC(2026, 10, 3, 18));
    await utimes(join(legacy, "old.log"), day, day);

    const result = await store.read("old", "p1");
    expect(result).toMatchObject({ legacy: true, complete: true });
    expect(result.entries.map((e) => [e.seq, e.text, e.at])).toEqual([
      [1, "==> Deploying", Date.UTC(2026, 10, 3, 10, 0, 0)],
      [2, "built", Date.UTC(2026, 10, 3, 10, 0, 1)],
    ]);
  });

  it("answers an unknown log with no entries, and refuses ids that are not plain ids", async () => {
    expect(await store.read("nothing", "p1")).toMatchObject({ entries: [], complete: false });
    await expect(store.read("../etc", "p1")).rejects.toThrow(/not a valid id/);
    await expect(store.append("d1", { ...batch(1, "x"), projectId: "a/b" })).rejects.toThrow(/not a valid id/);
  });
});
