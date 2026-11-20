import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { pipeNdjson, readNdjson } from "./ndjson";
import { StreamLimiter } from "./stream-limiter";

const bytes = (...parts: string[]) =>
  (async function* () {
    for (const part of parts) yield new TextEncoder().encode(part);
  })();

describe("readNdjson", () => {
  it("joins lines split across chunks, skips bad and blank lines, and reads a last line without a newline", async () => {
    const bad: string[] = [];
    const out: unknown[] = [];
    for await (const item of readNdjson(bytes('{"a":', '1}\n\n{"b"', ':2}\nnot json\n{"c":3}'), { onBad: (l) => bad.push(l) })) {
      out.push(item);
    }
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(bad).toEqual(["not json"]);
  });

  it("handles a multi-byte character split between chunks", async () => {
    const encoded = new TextEncoder().encode('{"t":"é"}\n');
    const body = (async function* () {
      yield encoded.slice(0, 7);
      yield encoded.slice(7);
    })();
    const out: unknown[] = [];
    for await (const item of readNdjson(body)) out.push(item);
    expect(out).toEqual([{ t: "é" }]);
  });
});

class FakeSink extends EventEmitter {
  chunks: string[] = [];
  ended = false;
  head: Record<string, string> = {};
  writeHead(_status: number, headers: Record<string, string>) {
    this.head = headers;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
  }
}

describe("pipeNdjson", () => {
  it("writes one JSON line per item and ends", async () => {
    const sink = new FakeSink();
    await pipeNdjson(sink, (async function* () {
      yield { type: "line", n: 1 };
      yield { type: "line", n: 2 };
    })());
    expect(sink.head["content-type"]).toBe("application/x-ndjson");
    expect(sink.chunks).toEqual(['{"type":"line","n":1}\n', '{"type":"line","n":2}\n']);
    expect(sink.ended).toBe(true);
  });

  it("stops the source and calls onClose when the client goes away", async () => {
    const sink = new FakeSink();
    let stopped = false;
    let closed = false;
    const source = (async function* () {
      try {
        for (let i = 0; ; i++) {
          yield { i };
          await new Promise((r) => setTimeout(r, 5));
        }
      } finally {
        stopped = true;
      }
    })();
    setTimeout(() => sink.emit("close"), 20);
    await pipeNdjson(sink, source, { onClose: () => (closed = true) });
    expect(closed).toBe(true);
    expect(stopped).toBe(true);
    expect(sink.ended).toBe(false);
  });
});

describe("StreamLimiter", () => {
  it("allows N per key and frees a slot once released (twice is harmless)", () => {
    const limiter = new StreamLimiter(2);
    const a = limiter.acquire("u1")!;
    const b = limiter.acquire("u1")!;
    expect(limiter.acquire("u1")).toBeNull();
    expect(limiter.acquire("u2")).not.toBeNull();
    a();
    a();
    expect(limiter.count("u1")).toBe(1);
    expect(limiter.acquire("u1")).not.toBeNull();
    b();
  });
});
