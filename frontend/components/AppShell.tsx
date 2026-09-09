"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "./AuthGate";
import { usePlatform } from "@/lib/platform/context";
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
];

const secondaryItems: NavItem[] = [
  { label: "Secrets", icon: "shield", key: "secrets", href: (id) => id ? `/projects/${id}/secrets` : "/projects" },
  { label: "Databases", icon: "database", key: "databases", href: (id) => id ? `/projects/${id}/databases` : "/projects" },
  { label: "Settings", icon: "settings", key: "settings", href: () => "/settings" },
];

const ACTIVE_PROJECT_KEY = "orbitops.activeProjectId";

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

  const handleLogout = async () => {
    await platform.logout();
    clear();
    router.replace("/login");
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
            <span className="user-avatar">{session?.user.avatarInitials ?? "AS"}</span>
            <span className="sidebar-user-copy"><strong>{session?.user.name ?? "Aarav Shah"}</strong><small>{session?.user.role ?? "Platform admin"}</small></span>
            <button className="icon-button ghost-button" aria-label="Sign out" onClick={handleLogout}><Icon name="log-out" size={16} /></button>
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
            <div className="topbar-avatar">{session?.user.avatarInitials ?? "AS"}</div>
          </div>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
