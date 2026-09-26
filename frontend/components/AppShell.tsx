"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./AuthGate";
import { usePlatform } from "@/lib/platform/context";
import { githubLoginUrl } from "@/lib/api/auth";
import type { User } from "@/lib/platform/types";
import { Icon, type IconName } from "./ui/Icon";

type NavItem = {
  label: string;
  icon: IconName;
  key: string;
  href: (projectId?: string) => string;
};

const navItems: NavItem[] = [
  { label: "Command center", icon: "activity", key: "dashboard", href: () => "/dashboard" },
  { label: "Projects", icon: "layers", key: "projects", href: () => "/projects" },
  { label: "Pipelines", icon: "terminal", key: "pipelines", href: (id) => id ? `/projects/${id}/pipelines` : "/projects" },
  { label: "Deployments", icon: "rocket", key: "deployments", href: (id) => id ? `/projects/${id}/deployments` : "/projects" },
  { label: "Observability", icon: "trend-up", key: "observability", href: (id) => id ? `/projects/${id}/observability` : "/projects" },
  // Last on purpose. activeKey() returns the first key contained in the path,
  // and "/projects/x/deployments" contains "/deploy" too - so "deployments"
  // has to be tested before this one.
  { label: "Deploy", icon: "rocket", key: "deploy", href: () => "/deploy" },
];

const secondaryItems: NavItem[] = [
  { label: "Secrets", icon: "shield", key: "secrets", href: (id) => id ? `/projects/${id}/secrets` : "/projects" },
  { label: "Databases", icon: "database", key: "databases", href: (id) => id ? `/projects/${id}/databases` : "/projects" },
  { label: "Settings", icon: "settings", key: "settings", href: () => "/settings" },
];

const ACTIVE_PROJECT_KEY = "orbitops.activeProjectId";

function Avatar({ user, className }: { user?: User; className: string }) {
  if (user?.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- remote GitHub avatar, not worth an images.remotePatterns entry
    return <img className={`${className} avatar-image`} src={user.avatarUrl} alt="" />;
  }
  return <span className={className}>{user?.avatarInitials ?? "?"}</span>;
}

function activeKey(pathname: string) {
  if (pathname === "/dashboard") return "dashboard";
  for (const item of [...navItems, ...secondaryItems]) {
    if (item.key !== "projects" && pathname.includes(`/${item.key}`)) return item.key;
  }
  if (pathname === "/projects" || pathname === "/projects/new" || /^\/projects\/[^/]+$/.test(pathname)) return "projects";
  return "dashboard";
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const platform = usePlatform();
  const { session, clear } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const routeProjectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const projectIdFromRoute = routeProjectId && routeProjectId !== "new" ? routeProjectId : undefined;
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(projectIdFromRoute);
  const selectedKey = activeKey(pathname);

  useEffect(() => {
    let active = true;

    const resolveActiveProject = async () => {
      const projects = await platform.listProjects();
      if (!active) return;

      const storedProjectId = window.localStorage.getItem(ACTIVE_PROJECT_KEY) ?? undefined;
      const nextProjectId = projectIdFromRoute
        ?? projects.find((project) => project.id === storedProjectId)?.id
        ?? projects[0]?.id;

      setActiveProjectId(nextProjectId);
      if (nextProjectId) {
        window.localStorage.setItem(ACTIVE_PROJECT_KEY, nextProjectId);
      }
    };

    void resolveActiveProject();
    return () => { active = false; };
  }, [platform, projectIdFromRoute]);

  useEffect(() => {
    if (!accountOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setAccountOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountOpen]);

  /**
   * Clears the backend session cookie. With `switchAccount`, goes straight on
   * to GitHub's account picker instead of the login screen.
   */
  const handleLogout = async (switchAccount = false) => {
    setSigningOut(true);
    try {
      await platform.logout();
    } catch {
      // The cookie is httpOnly, so the backend is the only thing that can
      // clear it; if that call failed the next /me will simply still succeed.
    }
    clear();
    window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
    if (switchAccount) {
      window.location.assign(githubLoginUrl("/dashboard", true));
    } else {
      router.replace("/login?signedOut=1");
    }
  };

  const renderNav = (items: NavItem[]) => items.map((item) => {
    const active = selectedKey === item.key;
    return (
      <Link
        key={item.key}
        href={item.href(activeProjectId)}
        className={`nav-link ${active ? "nav-link-active" : ""}`}
        onClick={() => setMobileOpen(false)}
      >
        <Icon name={item.icon} size={17} />
        <span>{item.label}</span>
        {item.key === "pipelines" && active ? <span className="nav-pulse" /> : null}
      </Link>
    );
  });

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <Link href="/dashboard" className="brand-lockup" onClick={() => setMobileOpen(false)}>
            <span className="brand-mark"><Icon name="rocket" size={18} /></span>
            <span><strong>OrbitOps</strong><small>Developer platform</small></span>
          </Link>
          <div className="workspace-switcher">
            <span className="workspace-avatar">OL</span>
            <span><small>Workspace</small><strong>OrbitOps Labs</strong></span>
            <Icon name="chevron-down" size={14} />
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          <p className="nav-caption">Workspace</p>
          {renderNav(navItems)}
          <p className="nav-caption nav-caption-spaced">Platform</p>
          {renderNav(secondaryItems)}
        </nav>

        <div className="sidebar-bottom">
          <div className="cluster-card">
            <div className="cluster-card-top"><span className="live-dot" /> Local cluster <span className="cluster-live">Live</span></div>
            <p>Kind / development</p>
            <div className="cluster-bar"><span /></div>
            <small>3 nodes · 14 workloads</small>
          </div>
          <div className="sidebar-user">
            <Avatar user={session?.user} className="user-avatar" />
            <span className="sidebar-user-copy"><strong>{session?.user.name}</strong><small>{session?.user.role}</small></span>
            <button className="icon-button ghost-button" aria-label="Sign out" title="Sign out" disabled={signingOut} onClick={() => void handleLogout()}><Icon name="log-out" size={16} /></button>
          </div>
        </div>
      </aside>

      {mobileOpen ? <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} /> : null}

      <div className="main-shell">
        <header className="topbar">
          <button className="mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button>
          <div className="breadcrumb"><span>OrbitOps Labs</span><Icon name="chevron-right" size={14} /><strong>{selectedKey === "dashboard" ? "Command center" : selectedKey[0].toUpperCase() + selectedKey.slice(1)}</strong></div>
          <div className="topbar-actions">
            <div className="topbar-health"><span className="live-dot" /> All systems nominal</div>
            <button className="icon-button" aria-label="View notifications"><Icon name="bell" size={17} /><span className="notification-dot" /></button>
            <div className="account-menu" ref={accountRef}>
              <button className="account-trigger" aria-label="Account menu" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen((open) => !open)}>
                <Avatar user={session?.user} className="topbar-avatar" />
              </button>
              {accountOpen ? (
                <div className="account-dropdown" role="menu">
                  <div className="account-dropdown-head">
                    <Avatar user={session?.user} className="user-avatar" />
                    <span className="sidebar-user-copy"><strong>{session?.user.name}</strong><small>{session?.user.githubUsername ? `@${session.user.githubUsername}` : session?.user.email}</small></span>
                  </div>
                  <button role="menuitem" className="account-dropdown-item" disabled={signingOut} onClick={() => void handleLogout(true)}><Icon name="users" size={15} /> Switch GitHub account</button>
                  <button role="menuitem" className="account-dropdown-item" disabled={signingOut} onClick={() => void handleLogout()}><Icon name="log-out" size={15} /> Sign out</button>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
