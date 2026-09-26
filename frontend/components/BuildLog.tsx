"use client";

import { useEffect, useRef } from "react";

/**
 * Raw build output.
 *
 * Distinct from LogViewer, which renders the structured LogEntry records the
 * mock platform emits. A docker build writes unstructured lines that are
 * already timestamped by the backend's log writer, so re-parsing them into
 * level/source columns would invent information that is not there.
 */
export function BuildLog({ lines, live }: { lines: string[]; live: boolean }) {
  const paneRef = useRef<HTMLPreElement>(null);
  const pinnedToBottom = useRef(true);

  // Autoscroll, but only while the user is already at the bottom - otherwise
  // scrolling up to read something would keep yanking them back down.
  useEffect(() => {
    const el = paneRef.current;
    if (el && pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const onScroll = () => {
    const el = paneRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <div className="log-dots"><i /><i /><i /></div>
        <span>{live ? "build output / streaming" : "build output"}</span>
        <span>{lines.length} lines</span>
      </div>
      <pre className="raw-log" ref={paneRef} onScroll={onScroll}>
        {lines.length ? lines.join("\n") : "Waiting for output…"}
      </pre>
    </div>
  );
}
