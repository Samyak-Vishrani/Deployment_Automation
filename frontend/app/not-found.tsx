import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

export default function NotFound() {
  return <main className="auth-loading"><div className="brand-mark brand-mark-large"><Icon name="circle-help" size={22} /></div><h1 style={{ margin: 0, fontSize: 24 }}>Page not found</h1><p style={{ margin: 0, color: "var(--ink-muted)" }}>The route you requested is not part of this workspace.</p><Link className="button button-primary" href="/dashboard">Back to command center <Icon name="arrow-up-right" size={15} /></Link></main>;
}
