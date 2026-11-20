/**
 * Reads newline-delimited JSON from a streamed fetch body: how the logs
 * service sends build-log and runtime-log streams. A line split across chunks
 * is joined; a line that is not JSON is skipped. (backend/logs has the same
 * reader in integration_common, which this app does not import.)
 */
export async function* readNdjson<T = unknown>(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<T> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line: string): T | undefined => {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return undefined;
    }
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const item = parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (item !== undefined) yield item;
    }
  }
  const last = parse(buffer + decoder.decode());
  if (last !== undefined) yield last;
}
