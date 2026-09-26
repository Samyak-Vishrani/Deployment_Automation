/**
 * Server-sent events for Next.js route handlers.
 *
 * NestJS's @Sse() decorator turned an Observable into this wire format; there
 * is no equivalent in the App Router, so the framing is written out once here.
 * The shape is unchanged, so the browser side keeps using
 * `source.addEventListener('change' | 'line' | 'done', ...)` exactly as before.
 */

export interface SseMessage {
  /** Becomes the SSE `event:` field, which is what addEventListener matches. */
  type: string;
  data: string;
}

export interface SseHandle {
  send(message: SseMessage): void;
  close(): void;
}

const encoder = new TextEncoder();

function frame(message: SseMessage): Uint8Array {
  // A payload containing newlines must be split across several data: lines, or
  // everything after the first newline is silently dropped by the client.
  const data = message.data.split("\n").map((line) => `data: ${line}`).join("\n");
  return encoder.encode(`event: ${message.type}\n${data}\n\n`);
}

/**
 * Builds the streaming Response and hands `setup` a writer.
 *
 * `setup` returns a teardown function, run when the stream ends for any reason
 * - a terminal event, or the browser navigating away. Without unsubscribing
 * there, every closed tab would leave a listener on the log bus for the life of
 * the process.
 */
export function sseResponse(
  request: Request,
  setup: (handle: SseHandle) => void | (() => void),
): Response {
  let teardown: (() => void) | void;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          teardown?.();
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed by the runtime when the client disconnected.
          }
        }
      };

      const handle: SseHandle = {
        send(message) {
          if (closed) return;
          try {
            controller.enqueue(frame(message));
          } catch {
            // The client went away between the check and the enqueue.
            finish();
          }
        },
        close: finish,
      };

      // Closing the tab aborts the request; without this the heartbeat interval
      // would keep the stream - and its subscription - alive indefinitely.
      request.signal.addEventListener("abort", finish, { once: true });

      teardown = setup(handle);
    },
    cancel() {
      if (closed) return;
      closed = true;
      teardown?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and similar proxies buffer responses by default, which holds
      // every line back until the build finishes.
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * A periodic comment-free ping.
 *
 * Dev tunnels and reverse proxies drop idle SSE connections, and a slow build
 * can be silent for minutes, so the stream has to say something.
 */
export function startHeartbeat(handle: SseHandle, everyMs = 15_000): () => void {
  const timer = setInterval(() => handle.send({ type: "ping", data: "" }), everyMs);
  return () => clearInterval(timer);
}
