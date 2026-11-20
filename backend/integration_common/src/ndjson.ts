/**
 * Newline-delimited JSON over a streamed HTTP body (Phase 12): how backend/logs
 * streams build and runtime logs to the main backend, and how it reads
 * Vercel's runtime-log stream. No dependencies: it works on any async iterable
 * of bytes (a fetch body in Node 22) and any Node-style response.
 */

/**
 * Parsed lines of a streamed body, one per "\n". A line split across chunks is
 * joined; a line that is not JSON is skipped and reported to `onBad`. Stops
 * when the body ends or `signal` aborts.
 */
export async function* readNdjson<T = unknown>(
  body: AsyncIterable<Uint8Array> | null | undefined,
  options: { signal?: AbortSignal; onBad?: (line: string) => void } = {},
): AsyncGenerator<T> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = function* (text: string): Generator<T> {
    const line = text.trim();
    if (!line) return;
    try {
      yield JSON.parse(line) as T;
    } catch {
      options.onBad?.(line.slice(0, 200));
    }
  };
  for await (const chunk of body) {
    if (options.signal?.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield* parse(line);
    }
  }
  buffer += decoder.decode();
  yield* parse(buffer);
}

/** The part of a Node `ServerResponse` (Fastify's `reply.raw`) this needs. */
export interface NdjsonSink {
  writeHead?(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): boolean;
  end(): void;
  once(event: "close", listener: () => void): unknown;
}

export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/**
 * Writes `source` to `sink` as NDJSON, with `{"type":"heartbeat"}` every
 * `heartbeatMs` so idle connections are not cut by anything in between. When
 * the client goes away, `onClose` runs (abort the upstream there) and the
 * source is stopped. Resolves once the stream is finished either way.
 */
export async function pipeNdjson(
  sink: NdjsonSink,
  source: AsyncIterable<unknown>,
  options: { heartbeatMs?: number; onClose?: () => void; headers?: Record<string, string> } = {},
): Promise<void> {
  let closed = false;
  sink.once("close", () => {
    closed = true;
    options.onClose?.();
  });
  sink.writeHead?.(200, {
    "content-type": NDJSON_CONTENT_TYPE,
    "cache-control": "no-store",
    ...options.headers,
  });
  const heartbeat = setInterval(() => {
    if (!closed) sink.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
  }, options.heartbeatMs ?? 15_000);
  try {
    for await (const item of source) {
      if (closed) break;
      sink.write(`${JSON.stringify(item)}\n`);
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed) sink.end();
  }
}
