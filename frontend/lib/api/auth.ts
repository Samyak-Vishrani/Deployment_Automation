import { api } from "./client";
import { getApiBaseUrl } from "./config";
import { ApiError } from "./error";
import type { Session } from "@/lib/platform/types";

/**
 * Sign-in is a full-page redirect through the backend to GitHub and back, not
 * a fetch: GitHub's consent screen cannot be shown inside an XHR.
 *
 * `switchAccount` makes GitHub show its account picker. Signing out of OrbitOps
 * does not sign the browser out of GitHub, so without it the next sign-in goes
 * straight back to the same GitHub account.
 */
export function githubLoginUrl(next?: string | null, switchAccount = false): string {
  const params = new URLSearchParams();
  if (next) params.set("next", next);
  if (switchAccount) params.set("switch", "1");
  const query = params.toString();
  return `${getApiBaseUrl()}/api/auth/github${query ? `?${query}` : ""}`;
}

/** The session cookie lives on the backend's origin, so every call opts into sending it. */
const withSession: RequestInit = { credentials: "include" };

export async function fetchSession(): Promise<Session | null> {
  try {
    return await api.get<Session>("/api/auth/me", withSession);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function signOut(): Promise<void> {
  await api.post<void>("/api/auth/logout", undefined, withSession);
}
