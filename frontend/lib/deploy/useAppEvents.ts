"use client";

import { useEffect, useRef } from "react";
import { streamUrl } from "./client";

/**
 * Subscribes to the backend's app-wide change feed and runs `onChange`
 * whenever anything happens.
 *
 * Replaces per-page polling. Events carry only identifiers, so the callback
 * refetches rather than trusting a payload - which means a tab that missed
 * events while asleep still converges as soon as it reconnects, and there is
 * only one shape of a project in the codebase.
 */
export function useAppEvents(onChange: () => void): void {
  // Kept in a ref so a caller passing an inline arrow does not tear down and
  // rebuild the EventSource on every render. Assigned in an effect rather than
  // during render: a ref write during render is not safe under concurrent
  // rendering, where a render can be thrown away.
  const handler = useRef(onChange);

  useEffect(() => {
    handler.current = onChange;
  }, [onChange]);

  useEffect(() => {
    // withCredentials, or the httpOnly session cookie never reaches :3001 and
    // the stream is refused with a 401 the browser reports as a bare error.
    const source = new EventSource(streamUrl("/api/events"), { withCredentials: true });
    source.addEventListener("change", () => handler.current());
    // EventSource reconnects on its own; nothing to do here but avoid noise.
    source.onerror = () => undefined;
    return () => source.close();
  }, []);
}
