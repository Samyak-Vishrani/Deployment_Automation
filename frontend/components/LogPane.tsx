"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { entryToText, formatTime, isErrorLine, SOURCE_LABEL } from "@/lib/deploy/log-format";
import type { LogSource } from "@/lib/deploy/types";

/** One row, from a build-log entry or a runtime line. */
export type PaneLine = {
  key: string;
  at: number;
  source: LogSource;
  stream: string;
  level?: string;
  text: string;
  request?: { method?: string; path?: string; status?: number };
};

export interface LogPaneProps {
  lines: PaneLine[];
  /** New lines are still arriving. */
  live: boolean;
  /** Toolbar label, e.g. "build output" or "runtime · Render". */
  label: string;
  emptyText: string;
  /** Lines dropped from the front to stay under the in-browser limit. */
  dropped?: number;
  /** A server-rendered download (build logs); without it, Download saves what is on screen. */
  downloadHref?: string;
  downloadName?: string;
}

/**
 * The log viewer of the build page and the Logs page (Phase 12). It shows ONE
 * deployment's or ONE component's lines, never a mix of components:
 * - a source badge per line (OrbitOps, Vercel, Render, Neon, Docker), and chips
 *   to show or hide each source present;
 * - error lines tinted, counted, and reachable with ↑/↓; "Errors only";
 * - search with n of m and Enter / Shift+Enter;
 * - wrap and time toggles, Copy (what is visible) and Download;
 * - autoscroll only while pinned to the bottom, with "Jump to latest".
 */
export function LogPane({ lines, live, label, emptyText, dropped = 0, downloadHref, downloadName }: LogPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [hidden, setHidden] = useState<Set<LogSource>>(new Set());
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [showTime, setShowTime] = useState(true);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [errorIndex, setErrorIndex] = useState(-1);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [copied, setCopied] = useState(false);

  const sources = useMemo(() => [...new Set(lines.map((l) => l.source))], [lines]);
  const visible = useMemo(
    () =>
      lines.filter((l) => !hidden.has(l.source) && (!errorsOnly || isErrorLine(l))),
    [lines, hidden, errorsOnly],
  );
  const errorRows = useMemo(() => visible.flatMap((l, i) => (isErrorLine(l) ? [i] : [])), [visible]);
  const needle = query.trim().toLowerCase();
  const matchRows = useMemo(
    () => (needle ? visible.flatMap((l, i) => (lineText(l).toLowerCase().includes(needle) ? [i] : [])) : []),
    [visible, needle],
  );
  const currentMatch = matchRows.length ? Math.min(matchIndex, matchRows.length - 1) : -1;

  // Autoscroll, but only while the reader is already at the bottom.
  useEffect(() => {
    const el = paneRef.current;
    if (el && pinned.current && !needle && errorIndex < 0) el.scrollTop = el.scrollHeight;
  }, [visible, needle, errorIndex]);

  const scrollToRow = (row: number) => {
    const el = paneRef.current?.querySelector<HTMLElement>(`[data-row="${row}"]`);
    if (el) {
      pinned.current = false;
      el.scrollIntoView({ block: "center" });
    }
  };

  const onScroll = () => {
    const el = paneRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    pinned.current = atBottom;
    setAwayFromBottom(!atBottom);
  };

  const jumpToLatest = () => {
    const el = paneRef.current;
    if (!el) return;
    pinned.current = true;
    setErrorIndex(-1);
    el.scrollTop = el.scrollHeight;
    setAwayFromBottom(false);
  };

  const stepMatch = (delta: number) => {
    if (!matchRows.length) return;
    const next = (currentMatch + delta + matchRows.length) % matchRows.length;
    setMatchIndex(next);
    scrollToRow(matchRows[next]);
  };

  const stepError = (delta: number) => {
    if (!errorRows.length) return;
    const next = errorIndex < 0 ? (delta > 0 ? 0 : errorRows.length - 1) : (errorIndex + delta + errorRows.length) % errorRows.length;
    setErrorIndex(next);
    scrollToRow(errorRows[next]);
  };

  const toggleSource = (source: LogSource) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });

  const asText = () => visible.map((l) => entryToText({ ...l, text: lineText(l) })).join("\n");

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(asText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  };

  const onDownloadScreen = () => {
    const blob = new Blob([asText() + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName ?? "logs.log";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="log-viewer log-pane">
      <div className="lp-toolbar">
        <div className="lp-toolbar-group">
          <span className="lp-label">
            {live ? <span className="live-dot" /> : null}
            {label}
          </span>
          <span className="tiny-label">
            {visible.length === lines.length ? `${lines.length} lines` : `${visible.length} of ${lines.length} lines`}
          </span>
        </div>
        <div className="lp-toolbar-group">
          {sources.length > 1
            ? sources.map((source) => (
                <button
                  key={source}
                  type="button"
                  className={`lp-chip lp-src-${source}${hidden.has(source) ? " lp-chip-off" : ""}`}
                  onClick={() => toggleSource(source)}
                  title={hidden.has(source) ? `Show ${SOURCE_LABEL[source]} lines` : `Hide ${SOURCE_LABEL[source]} lines`}
                >
                  {SOURCE_LABEL[source]}
                </button>
              ))
            : null}
          <button type="button" className={`lp-chip${errorsOnly ? " lp-chip-on" : ""}`} onClick={() => setErrorsOnly((v) => !v)}>
            Errors only
          </button>
          <span className={`lp-errors${errorRows.length ? " lp-errors-some" : ""}`} title="Lines that look like errors">
            {errorRows.length} error{errorRows.length === 1 ? "" : "s"}
            <button type="button" aria-label="Previous error" onClick={() => stepError(-1)} disabled={!errorRows.length}>
              ↑
            </button>
            <button type="button" aria-label="Next error" onClick={() => stepError(1)} disabled={!errorRows.length}>
              ↓
            </button>
          </span>
        </div>
        <div className="lp-toolbar-group">
          <span className="lp-search">
            <Icon name="search" size={12} />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  stepMatch(e.shiftKey ? -1 : 1);
                }
              }}
              placeholder="Search"
              aria-label="Search the log"
              spellCheck={false}
            />
            {needle ? <span className="tiny-label">{matchRows.length ? `${currentMatch + 1} of ${matchRows.length}` : "0"}</span> : null}
          </span>
          <button type="button" className={`lp-chip${wrap ? " lp-chip-on" : ""}`} onClick={() => setWrap((v) => !v)}>
            Wrap
          </button>
          <button type="button" className={`lp-chip lp-time-toggle${showTime ? " lp-chip-on" : ""}`} onClick={() => setShowTime((v) => !v)}>
            Time
          </button>
          <button type="button" className="lp-chip" onClick={() => void onCopy()} disabled={!visible.length}>
            {copied ? "Copied" : "Copy"}
          </button>
          {downloadHref ? (
            <a className="lp-chip" href={downloadHref}>
              Download
            </a>
          ) : (
            <button type="button" className="lp-chip" onClick={onDownloadScreen} disabled={!visible.length}>
              Download
            </button>
          )}
        </div>
      </div>

      {dropped > 0 ? (
        <div className="lp-banner">The first {dropped} lines are not shown (only the latest 10 000 are kept here). Download has them all.</div>
      ) : null}

      <div className={`lp-body${wrap ? " lp-wrap" : ""}`} ref={paneRef} onScroll={onScroll} role="log" aria-live={live ? "polite" : "off"}>
        {visible.length === 0 ? (
          <div className="lp-empty">{lines.length ? "No line matches these filters." : emptyText}</div>
        ) : (
          visible.map((line, i) => {
            const error = isErrorLine(line);
            const isMatch = currentMatch >= 0 && matchRows[currentMatch] === i;
            const isError = errorIndex >= 0 && errorRows[errorIndex] === i;
            return (
              <div
                key={line.key}
                data-row={i}
                className={`lp-row${error ? " lp-row-error" : ""}${line.stream === "info" ? " lp-row-info" : ""}${isMatch || isError ? " lp-row-focus" : ""}`}
              >
                {showTime ? <span className="lp-time">{formatTime(line.at)}</span> : null}
                <span className={`lp-src lp-src-${line.source}`}>{SOURCE_LABEL[line.source]}</span>
                {line.level && line.level !== "info" ? <span className="lp-level">{line.level}</span> : null}
                <span className="lp-text">{highlight(lineText(line), needle)}</span>
              </div>
            );
          })
        )}
      </div>

      {awayFromBottom && live ? (
        <button type="button" className="lp-jump" onClick={jumpToLatest}>
          Jump to latest ↓
        </button>
      ) : null}
    </div>
  );
}

/** A request line shows `GET /path 200` when its text does not already say so. */
function lineText(line: PaneLine): string {
  const req = line.request;
  if (!req?.path) return line.text;
  const summary = [req.method, req.path, req.status].filter(Boolean).join(" ");
  return line.text.includes(req.path) ? line.text : `${summary} · ${line.text}`;
}

function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(needle);
  while (at >= 0) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  parts.push(text.slice(from));
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}
