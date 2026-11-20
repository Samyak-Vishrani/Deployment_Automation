"use client";

import { useEffect, useRef, useState } from "react";
import { streamUrl } from "./client";
import type { DeployLogEntry, DeploymentStatus } from "./types";

const MAX_ENTRIES = 10_000;
const FLUSH_MS = 100;

export interface BuildLogStream {
  entries: DeployLogEntry[];
  /** Entries dropped from the front to stay under 10 000. */
  dropped: number;
  /** The deployment's final status once the log is done; null while it runs. */
  doneStatus: DeploymentStatus | null;
  /** The stream is open (false while EventSource reconnects). */
  connected: boolean;
  error: string;
}

/**
 * ONE deployment's build log, replayed and then tailed live (Phase 12).
 *
 * Every line carries its seq as the SSE id, so when the connection drops,
 * EventSource reconnects with Last-Event-ID and the backend sends only what
 * was missed; a seq already shown is ignored, so a reconnect never
 * duplicates. Lines are applied in small batches to keep a fast build smooth.
 * Remount (key) it to switch deployments.
 */
export function useBuildLogStream(deploymentId: string): BuildLogStream {
  const [entries, setEntries] = useState<DeployLogEntry[]>([]);
  /** Lines received in total; beyond the 10 000 kept, the oldest were dropped. */
  const [received, setReceived] = useState(0);
  const [doneStatus, setDoneStatus] = useState<DeploymentStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<DeployLogEntry[]>([]);

  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const batch = pending.current;
      pending.current = [];
      if (batch.length === 0) return;
      setReceived((n) => n + batch.length);
      setEntries((prev) => {
        const next = prev.concat(batch);
        return next.length <= MAX_ENTRIES ? next : next.slice(next.length - MAX_ENTRIES);
      });
    };

    const source = new EventSource(streamUrl(`/api/deployments/${encodeURIComponent(deploymentId)}/logs/stream`), {
      withCredentials: true,
    });
    source.onopen = () => {
      setConnected(true);
      setError("");
    };
    source.addEventListener("entry", (event) => {
      let entry: DeployLogEntry;
      try {
        entry = JSON.parse((event as MessageEvent<string>).data) as DeployLogEntry;
      } catch {
        return;
      }
      if (entry.seq <= last) return;
      last = entry.seq;
      pending.current.push(entry);
      timer ??= setTimeout(flush, FLUSH_MS);
    });
    source.addEventListener("done", (event) => {
      flush();
      try {
        setDoneStatus((JSON.parse((event as MessageEvent<string>).data) as { status: DeploymentStatus }).status);
      } catch {
        setDoneStatus("success");
      }
      // Close explicitly, or EventSource reconnects for ever once the server completes the stream.
      source.close();
      setConnected(false);
    });
    source.onerror = () => {
      setConnected(false);
      if (source.readyState === EventSource.CLOSED) {
        // A non-200 answer (the logs service is down, say): read its message.
        void fetch(streamUrl(`/api/deployments/${encodeURIComponent(deploymentId)}/logs?format=entries&limit=1`), { credentials: "include" })
          .then(async (res) => {
            if (!res.ok) setError(((await res.json().catch(() => ({}))) as { message?: string }).message ?? "Could not load the log.");
          })
          .catch(() => setError("Could not reach the backend."));
      }
      // Otherwise EventSource is reconnecting by itself, resuming from the last seq.
    };

    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [deploymentId]);

  return { entries, dropped: Math.max(0, received - entries.length), doneStatus, connected, error };
}
