import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockUpsert } = vi.hoisted(() => ({ mockUpsert: vi.fn() }));

// Only the database write is mocked: the token exchange and profile read run
// for real against a stubbed fetch, and the sealing happens in users.ts's
// helper, which is what the "no plaintext" assertion is about.
vi.mock("@/lib/auth/users", async () => {
  const { sealTokenColumns } = await import("@/lib/auth/github-tokens");
  return {
    upsertGithubUser: (profile: unknown, tokens: Parameters<typeof sealTokenColumns>[0]) =>
      mockUpsert(profile, sealTokenColumns(tokens)),
  };
});

import { encodeOAuthState, OAUTH_STATE_COOKIE } from "@/lib/auth/github-oauth";
import { open } from "@/lib/crypto/secret-box";
import { GET } from "./route";

const mockFetch = vi.fn(async (url: string) => {
  const body =
    url === "https://github.com/login/oauth/access_token"
      ? {
          access_token: "ghu_plaintext",
          expires_in: 28800,
          refresh_token: "ghr_plaintext",
          refresh_token_expires_in: 15811200,
        }
      : url.endsWith("/user")
        ? { id: 42, login: "octo", name: "Octo", email: null, avatar_url: null }
        : [{ email: "octo@example.com", primary: true, verified: true }];
  return { ok: true, status: 200, json: async () => body };
});

const SAVED = { state: "state_abc", verifier: "verifier_xyz", next: "/dashboard" };

function callback(query: string, withCookie = true) {
  const request = new NextRequest(`http://localhost:3001/api/auth/github/callback${query}`);
  if (withCookie) {
    request.cookies.set(OAUTH_STATE_COOKIE, encodeOAuthState(SAVED));
  }
  return GET(request);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "Iv1.client");
  vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "secret");
  mockUpsert.mockResolvedValue("user_1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/auth/github/callback", () => {
  it("bounces an install redirect to sign-in without exchanging its code", async () => {
    const response = await callback("?code=install_code&installation_id=123&setup_action=install", false);

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/api/auth/github");
    expect(location.searchParams.get("next")).toBe("/deploy/new");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("bounces an install redirect even when a stale state cookie is present", async () => {
    const response = await callback("?code=install_code&installation_id=123&setup_action=update");

    expect(new URL(response.headers.get("location")!).pathname).toBe("/api/auth/github");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("signs in and stores the token pair sealed", async () => {
    const response = await callback("?code=good_code&state=state_abc");

    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard");
    expect(response.cookies.get("orbitops_session")?.value).toBeTruthy();

    const [profile, columns] = mockUpsert.mock.calls[0];
    expect(profile).toMatchObject({ githubUserId: "42", login: "octo", email: "octo@example.com" });
    expect(JSON.stringify(columns)).not.toContain("plaintext");
    expect(columns.accessTokenEnc.startsWith("v1.")).toBe(true);
    expect(open(columns.accessTokenEnc)).toBe("ghu_plaintext");
    expect(open(columns.refreshTokenEnc)).toBe("ghr_plaintext");
    expect(columns.accessTokenExpiresAt).toBeInstanceOf(Date);
  });

  it("refuses a code whose state does not match", async () => {
    const response = await callback("?code=good_code&state=other");

    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=invalid_state");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
