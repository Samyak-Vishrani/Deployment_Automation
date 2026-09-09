"use client";

import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "arrow-up-right"
  | "bell"
  | "box"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "circle-help"
  | "clock"
  | "code"
  | "database"
  | "external"
  | "eye"
  | "file-text"
  | "github"
  | "globe"
  | "layers"
  | "link"
  | "lock"
  | "log-out"
  | "menu"
  | "more"
  | "plus"
  | "refresh"
  | "rocket"
  | "search"
  | "server"
  | "settings"
  | "shield"
  | "sparkles"
  | "terminal"
  | "trend-up"
  | "users"
  | "x";

type Props = SVGProps<SVGSVGElement> & {
  name: IconName;
  size?: number;
};

export function Icon({ name, size = 18, ...props }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };

  switch (name) {
    case "activity":
      return <svg {...common}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>;
    case "arrow-up-right":
      return <svg {...common}><path d="M7 17 17 7M7 7h10v10" /></svg>;
    case "bell":
      return <svg {...common}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
    case "box":
      return <svg {...common}><path d="m21 8-9 5-9-5 9-5 9 5Z" /><path d="M3 8v8l9 5 9-5V8M12 13v8" /></svg>;
    case "check":
      return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case "chevron-down":
      return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
    case "chevron-left":
      return <svg {...common}><path d="m15 18-6-6 6-6" /></svg>;
    case "chevron-right":
      return <svg {...common}><path d="m9 18 6-6-6-6" /></svg>;
    case "circle-help":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.4 2.4 0 1 1 4.3 1.5c-.8 1-2 1.2-2 2.8M12 17h.01" /></svg>;
    case "clock":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case "code":
      return <svg {...common}><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" /></svg>;
    case "database":
      return <svg {...common}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></svg>;
    case "external":
      return <svg {...common}><path d="M14 5h5v5M19 5l-8 8" /><path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" /></svg>;
    case "eye":
      return <svg {...common}><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>;
    case "file-text":
      return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></svg>;
    case "github":
      return <svg {...common}><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.1.1 15 2.1a13.4 13.4 0 0 0-6 0C5.9.1 4.7.5 4.7.5A5 5 0 0 0 4.6 4 5.4 5.4 0 0 0 3.2 7.5c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 9 18v4" /><path d="M9 18c-4.5 2-5-2-7-2" /></svg>;
    case "globe":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.3 2.5 3.5 5.5 3.5 9s-1.2 6.5-3.5 9c-2.3-2.5-3.5-5.5-3.5-9S9.7 5.5 12 3Z" /></svg>;
    case "layers":
      return <svg {...common}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></svg>;
    case "link":
      return <svg {...common}><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" /></svg>;
    case "lock":
      return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
    case "log-out":
      return <svg {...common}><path d="M10 17l5-5-5-5M15 12H3" /><path d="M21 19V5a2 2 0 0 0-2-2h-5" /></svg>;
    case "menu":
      return <svg {...common}><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
    case "more":
      return <svg {...common}><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></svg>;
    case "plus":
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case "refresh":
      return <svg {...common}><path d="M20 11a8.1 8.1 0 0 0-14.8-4L3 10M3 5v5h5M4 13a8.1 8.1 0 0 0 14.8 4L21 14m0 5v-5h-5" /></svg>;
    case "rocket":
      return <svg {...common}><path d="M14.5 5.5c2.6-2.6 5.7-2.5 5.7-2.5s.1 3.1-2.5 5.7l-5.4 5.4-3.7-3.7 5.9-4.9Z" /><path d="m8.6 10.4-3.1.4-2.7 2.7 5.3.3M13.6 15.4l-.4 3.1-2.7 2.7-.3-5.3M6.1 17.9c-1.3.4-2.1-.4-1.7-1.7.3-1 1.2-1.5 2.3-1.3.8.2 1.1 1 .8 1.8-.2.6-.8 1-1.4 1.2Z" /></svg>;
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 5 5" /></svg>;
    case "server":
      return <svg {...common}><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" /></svg>;
    case "settings":
      return <svg {...common}><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="m19.4 15 .1.1a2 2 0 1 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4v.3a2 2 0 1 1-4 0v-.2A2 2 0 0 0 5.8 18l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A2 2 0 0 0 1.6 12a2 2 0 1 1 0-4h.2A2 2 0 0 0 3 4.6l-.1-.1A2 2 0 1 1 5.7 1.7l.1.1A2 2 0 0 0 9.2.4V.2a2 2 0 1 1 4 0v.2a2 2 0 0 0 3.4 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A2 2 0 0 0 20.8 8h.2a2 2 0 1 1 0 4h-.2a2 2 0 0 0-1.4 3Z" /></svg>;
    case "shield":
      return <svg {...common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>;
    case "sparkles":
      return <svg {...common}><path d="m12 3-1.1 4.2a4 4 0 0 1-2.8 2.8L4 11l4.1 1a4 4 0 0 1 2.8 2.8L12 19l1.1-4.2a4 4 0 0 1 2.8-2.8L20 11l-4.1-1a4 4 0 0 1-2.8-2.8L12 3ZM19 17v4M21 19h-4M5 3v4M7 5H3" /></svg>;
    case "terminal":
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>;
    case "trend-up":
      return <svg {...common}><path d="m3 17 6-6 4 4 7-8" /><path d="M15 7h5v5" /></svg>;
    case "users":
      return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></svg>;
    case "x":
      return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    default:
      return null;
  }
}
