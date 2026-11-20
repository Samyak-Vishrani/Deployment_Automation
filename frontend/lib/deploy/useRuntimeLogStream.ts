"use client";

import { useEffect, useRef, useState } from "react";
import { pingRuntimeLogs, runtimeLogsUrl } from "./client";
import type { RuntimeLogEntry, RuntimeSince } from "./types";

const MAX_ENTRIES = 10_000;
const FLUSH_MS = 100;
const PING_MS = 60_000;

export interface RuntimeLogOptions {
  since: RuntimeSince;
  /** Render only: include HTTP request lines. */
  requests: boolean;
  /** False = paused (no stream open). */
  enabled: boolean;
  /** Bump to reconnect after an `end`. */
  resumeToken: number;
}

export interface RuntimeLogStream {
  entries: RuntimeLogEntry[];
  dropped: number;
  notices: string[];
  ended: { reason: string; message: string } | null;
  connected: boolean;
  error: { code: string; message: string } | null;
}

/**
 * A running component's logs, live (Phase 12): Render app logs, Vercel
 * function logs or the local Docker container. The logs service tails the
 * provider only while this is open, and nothing is stored. While the tab is
 * visible it pings every minute, so a forgotten tab ends "idle" by itself.
 * Remount (key) it to switch components.
 */
export function useRuntimeLogStream(projectId: string, componentId: string | null, options: RuntimeLogOptions): RuntimeLogStream {
  const [entries, setEntries] = useState<RuntimeLogEntry[]>([]);
  /** Lines received in total; beyond the 10 000 kept, the oldest were dropped. */
  const [received, setReceived] = useState(0);
  const [notices, setNotices] = useState<string[]>([]);
  const [ended, setEnded] = useState<RuntimeLogStream["ended"]>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<RuntimeLogStream["error"]>(null);
  const pending = useRef<RuntimeLogEntry[]>([]);
  /** Ids already shown, kept across Resume so the backfill of a new tail does not repeat lines. */
  const seenRef = useRef(new Set<string>());
  const { since, requests, enabled, resumeToken } = options;

  useEffect(() => {
    if (!enabled) return;
    const url = runtimeLogsUrl(projectId, componentId, { since, requests });
    const seen = seenRef.current;
    let sessionId = "";
    let opened = false;
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

    const source = new EventSource(url, { withCredentials: true });
    source.addEventListener("session", (event) => {
      opened = true;
      setConnected(true);
      setEnded(null);
      setError(null);
      try {
        sessionId = (JSON.parse((event as MessageEvent<string>).data) as { sessionId: string }).sessionId;
      } catch {
        sessionId = "";
      }
    });
    source.addEventListener("entry", (event) => {
      try {
        const entry = JSON.parse((event as MessageEvent<string>).data) as RuntimeLogEntry;
        // A reconnect opens a new tail with a backfill; lines already shown are skipped.
        if (seen.has(entry.id)) return;
        seen.add(entry.id);
        if (seen.size > 20_000) seen.clear();
        pending.current.push(entry);
        timer ??= setTimeout(flush, FLUSH_MS);
      } catch {
        /* ignore a malformed line */
      }
    });
    source.addEventListener("notice", (event) => {
      try {
        const { text } = JSON.parse((event as MessageEvent<string>).data) as { text: string };
        setNotices((prev) => [...prev.slice(-4), text]);
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("end", (event) => {
      flush();
      try {
        setEnded(JSON.parse((event as MessageEvent<string>).data) as { reason: string; message: string });
      } catch {
        setEnded({ reason: "error", message: "The log stream ended." });
      }
      source.close();
      setConnected(false);
    });
    source.onerror = () => {
      setConnected(false);
      if (source.readyState !== EventSource.CLOSED) return; // reconnecting by itself
      if (opened) {
        setEnded({ reason: "error", message: "The log stream was interrupted. Resume to reconnect." });
        return;
      }
      // Refused before it started: read the reason (an error answer is JSON, not a stream).
      const probe = new AbortController();
      void fetch(url, { credentials: "include", signal: probe.signal })
        .then(async (res) => {
          if (res.ok) {
            probe.abort();
            setError({ code: "stream_failed", message: "The log stream could not be opened. Try again." });
            return;
          }
          const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
          setError({ code: body.error ?? "request_failed", message: body.message ?? `HTTP ${res.status}` });
        })
        .catch(() => setError({ code: "network", message: "Could not reach the backend." }));
    };

    const ping = setInterval(() => {
      if (sessionId && document.visibilityState === "visible") void pingRuntimeLogs(projectId, sessionId).catch(() => undefined);
    }, PING_MS);

    return () => {
      clearInterval(ping);
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [projectId, componentId, since, requests, enabled, resumeToken]);

  return { entries, dropped: Math.max(0, received - entries.length), notices, ended, connected, error };
}
