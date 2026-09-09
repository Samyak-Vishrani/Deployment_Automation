"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { usePlatform } from "@/lib/platform/context";

export default function LoginPage() {
  const platform = usePlatform();
  const router = useRouter();
  const [email, setEmail] = useState("demo@orbitops.dev");
  const [password, setPassword] = useState("orbitops");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await platform.login(email, password);
      const next = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("next") : null;
      router.replace(next || "/dashboard");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="login-story-top">
          <div className="brand-lockup login-brand"><span className="brand-mark"><Icon name="rocket" size={18} /></span><span><strong>OrbitOps</strong><small>Developer platform</small></span></div>
          <span className="story-status"><span className="live-dot" /> Demo environment</span>
        </div>
        <div className="story-content">
          <p className="eyebrow">One control plane for delivery</p>
          <h1>Ship with context, not guesswork.</h1>
          <p className="story-lede">Connect a repository, watch every stage move through the pipeline, and understand what happened when a release needs attention.</p>
          <div className="story-features">
            <div><span className="feature-icon"><Icon name="layers" size={17} /></span><span><strong>Projects in one view</strong><small>Keep source, environments, and release history together.</small></span></div>
            <div><span className="feature-icon"><Icon name="activity" size={17} /></span><span><strong>Delivery signals that make sense</strong><small>See pipeline stages, health checks, and logs in sequence.</small></span></div>
            <div><span className="feature-icon"><Icon name="sparkles" size={17} /></span><span><strong>Assistance when things break</strong><small>Turn failure evidence into a clear next action.</small></span></div>
          </div>
        </div>
        <div className="story-footer"><span>LOCAL CONTROL PLANE</span><span>v0.1 prototype</span></div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="mobile-login-brand"><span className="brand-mark"><Icon name="rocket" size={18} /></span><strong>OrbitOps</strong></div>
          <div className="login-heading"><span className="mini-kicker">Welcome back</span><h2>Sign in to your workspace</h2><p>Use the demo account to explore the delivery control plane.</p></div>
          <form onSubmit={submit} className="form-stack">
            <label className="field-label" htmlFor="email">Work email<input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
            <label className="field-label" htmlFor="password">Password<div className="input-with-icon"><Icon name="lock" size={16} /><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></div></label>
            {error ? <div className="form-error"><Icon name="circle-help" size={16} />{error}</div> : null}
            <button className="button button-primary button-full" disabled={submitting} type="submit">{submitting ? <><span className="button-spinner" /> Signing in</> : <>Enter workspace <Icon name="arrow-up-right" size={16} /></>}</button>
          </form>
          <button className="demo-credentials" type="button" onClick={() => { setEmail("demo@orbitops.dev"); setPassword("orbitops"); setError(""); }}><span className="demo-dot" /><span><strong>Demo access</strong><small>demo@orbitops.dev · orbitops</small></span><Icon name="chevron-right" size={15} /></button>
          <p className="login-note"><Icon name="shield" size={14} /> Development-only authentication. Production sessions will use a backend-issued HttpOnly JWT cookie.</p>
        </div>
        <div className="login-panel-footer"><span>Need access?</span><a href="mailto:platform@orbitops.dev">Contact platform team <Icon name="arrow-up-right" size={13} /></a></div>
      </section>
    </main>
  );
}
