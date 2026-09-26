"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { fetchSession, githubLoginUrl } from "@/lib/api/auth";

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "GitHub sign-in was cancelled.",
  invalid_state: "The sign-in link expired or was opened in another browser. Please try again.",
  github_failed: "GitHub sign-in failed. Please try again.",
  not_configured: "GitHub sign-in is not configured on the backend. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.",
};

// useSearchParams needs a Suspense boundary for the page to prerender.
export default function LoginPage() {
  return (
    <Suspense>
      <LoginScreen />
    </Suspense>
  );
}

function LoginScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const errorCode = params.get("error");
  const error = errorCode ? ERROR_MESSAGES[errorCode] ?? "Unable to sign in." : "";
  const signedOut = params.get("signedOut") === "1";
  const [redirecting, setRedirecting] = useState(false);

  // Already signed in (e.g. the back button after login): skip the screen.
  useEffect(() => {
    let active = true;
    fetchSession()
      .then((session) => { if (active && session) router.replace(next || "/dashboard"); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [next, router]);

  const signIn = (switchAccount: boolean) => {
    setRedirecting(true);
    window.location.assign(githubLoginUrl(next, switchAccount));
  };

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="login-story-top">
          <div className="brand-lockup login-brand"><span className="brand-mark"><Icon name="rocket" size={18} /></span><span><strong>OrbitOps</strong><small>Developer platform</small></span></div>
          <span className="story-status"><span className="live-dot" /> GitHub sign-in</span>
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
          <div className="login-heading">
            <span className="mini-kicker">{signedOut ? "Signed out" : "Welcome"}</span>
            <h2>Sign in to your workspace</h2>
            <p>{signedOut ? "You have been signed out. Continue with the same GitHub account or pick a different one." : "OrbitOps uses your GitHub account to identify you. We only read your public profile and email address."}</p>
          </div>
          <div className="form-stack">
            {error ? <div className="form-error"><Icon name="circle-help" size={16} />{error}</div> : null}
            <button className="button button-primary button-full" disabled={redirecting} type="button" onClick={() => signIn(false)}>
              {redirecting ? <><span className="button-spinner" /> Redirecting to GitHub</> : <><Icon name="github" size={16} /> Continue with GitHub</>}
            </button>
            <button className="button button-secondary button-full" disabled={redirecting} type="button" onClick={() => signIn(true)}>
              <Icon name="users" size={16} /> Use a different GitHub account
            </button>
          </div>
          <p className="login-note"><Icon name="shield" size={14} /> Signing out of OrbitOps does not sign you out of GitHub. To switch accounts, use &ldquo;Use a different GitHub account&rdquo;, or sign out at github.com first.</p>
        </div>
      </section>
    </main>
  );
}
