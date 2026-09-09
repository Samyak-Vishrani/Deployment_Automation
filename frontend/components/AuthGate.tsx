"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Session } from "@/lib/platform/types";
import { usePlatform } from "@/lib/platform/context";
import { Icon } from "./ui/Icon";

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  refresh: () => Promise<Session | null>;
  clear: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextSession = await platform.getSession();
      setSession(nextSession);
      return nextSession;
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    let active = true;

    platform.getSession()
      .then((nextSession) => {
        if (active) setSession(nextSession);
      })
      .catch(() => {
        if (active) setSession(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [platform]);

  const value = useMemo(() => ({ session, loading, refresh, clear: () => setSession(null) }), [loading, refresh, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return value;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !session) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [loading, pathname, router, session]);

  if (loading || !session) {
    return (
      <main className="auth-loading">
        <div className="brand-mark brand-mark-large"><Icon name="rocket" size={22} /></div>
        <div className="loading-orbit" />
        <p>Loading your workspace</p>
      </main>
    );
  }

  return <>{children}</>;
}
