"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <main className="auth-loading"><div className="brand-mark brand-mark-large"><Icon name="circle-help" size={22} /></div><h1 style={{ margin: 0, fontSize: 24 }}>Something interrupted the workspace</h1><p style={{ margin: 0, color: "var(--ink-muted)" }}>Try the page again or return to the command center.</p><div style={{ display: "flex", gap: 9, marginTop: 5 }}><button className="button button-secondary" type="button" onClick={() => reset()}>Try again <Icon name="refresh" size={14} /></button><Link className="button button-primary" href="/dashboard">Command center <Icon name="arrow-up-right" size={14} /></Link></div></main>;
}
