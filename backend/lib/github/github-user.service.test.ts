import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { HttpError } from "@/lib/api/http-error";
import { open, seal } from "@/lib/crypto/secret-box";
import { GithubUserService } from "@/lib/github/github-user.service";

const USER_ID = "user_1";
const REPO = { owner: "owner", repo: "repo", fullName: "owner/repo" };
const CONFIG = { clientId: "Iv1.client", clientSecret: "secret", callbackUrl: "http://cb" };
const TOKEN_URL = "https://github.com/login/oauth/access_token";

type Row = {
  id: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
};

const inMs = (ms: number) => new Date(Date.now() + ms);

function storedRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "conn_1",
    accessTokenEnc: seal("ghu_old"),
    refreshTokenEnc: seal("ghr_old"),
    accessTokenExpiresAt: inMs(8 * 3600_000),
    refreshTokenExpiresAt: inMs(180 * 24 * 3600_000),
    ...overrides,
  };
}

/** A GitHubConnection table of one row. */
function fakePrisma(initial: Row | null) {
  const state = { row: initial };
  const prisma = {
    gitHubConnection: {
      findFirst: vi.fn(async () => (state.row?.accessTokenEnc ? { ...state.row } : null)),
      update: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        state.row = { ...state.row!, ...data };
        return state.row;
      }),
      updateMany: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        state.row = state.row ? { ...state.row, ...data } : null;
        return { count: state.row ? 1 : 0 };
      }),
    },
  };
  return { state, prisma };
}

type Reply = { status: number; body: unknown };
const routes: Array<{ match: (url: string) => boolean; reply: (url: string, init?: RequestInit) => Reply }> = [];
const on = (match: string | RegExp, reply: Reply | ((url: string, init?: RequestInit) => Reply)) =>
  routes.push({
    match: (url) => (typeof match === "string" ? url === match : match.test(url)),
    reply: typeof reply === "function" ? reply : () => reply,
  });

const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
  const route = routes.find((r) => r.match(url));
  if (!route) throw new Error(`Unexpected fetch ${url}`);
  const { status, body } = route.reply(url, init);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
});

function makeService(row: Row | null = storedRow()) {
  const db = fakePrisma(row);
  const service = new GithubUserService(db.prisma as unknown as PrismaClient, () => CONFIG);
  return { service, db };
}

const refreshed = {
  access_token: "ghu_new",
  expires_in: 28800,
  refresh_token: "ghr_new",
  refresh_token_expires_in: 15811200,
};

const tokenCalls = () => mockFetch.mock.calls.filter(([url]) => url === TOKEN_URL);

const codeOf = (error: unknown) => (error instanceof HttpError ? error.code : String(error));

beforeEach(() => {
  routes.length = 0;
  mockFetch.mockClear();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GithubUserService.getToken", () => {
  it("returns the stored token while it is fresh", async () => {
    const { service } = makeService();

    await expect(service.getToken(USER_ID)).resolves.toBe("ghu_old");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses a token that never expires as is", async () => {
    const { service } = makeService(storedRow({ accessTokenExpiresAt: null, refreshTokenEnc: null }));

    await expect(service.getToken(USER_ID)).resolves.toBe("ghu_old");
  });

  it("refreshes a token about to expire and persists the rotated pair", async () => {
    on(TOKEN_URL, { status: 200, body: refreshed });
    const { service, db } = makeService(storedRow({ accessTokenExpiresAt: inMs(30_000) }));

    await expect(service.getToken(USER_ID)).resolves.toBe("ghu_new");

    const sent = JSON.parse(String(tokenCalls()[0][1]?.body));
    expect(sent).toMatchObject({ grant_type: "refresh_token", refresh_token: "ghr_old", client_id: "Iv1.client" });
    const row = db.state.row!;
    expect(open(row.accessTokenEnc!)).toBe("ghu_new");
    expect(open(row.refreshTokenEnc!)).toBe("ghr_new");
    expect(row.accessTokenEnc).not.toContain("ghu_new");
    expect(row.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 28_000_000);
  });

  it("refreshes once for concurrent callers", async () => {
    on(TOKEN_URL, { status: 200, body: refreshed });
    const { service } = makeService(storedRow({ accessTokenExpiresAt: inMs(-1000) }));

    const tokens = await Promise.all([
      service.getToken(USER_ID),
      service.getToken(USER_ID),
      service.getToken(USER_ID),
    ]);

    expect(tokens).toEqual(["ghu_new", "ghu_new", "ghu_new"]);
    expect(tokenCalls()).toHaveLength(1);
  });

  it("does not reuse a spent refresh token after an earlier refresh finished", async () => {
    on(TOKEN_URL, { status: 200, body: refreshed });
    const { service } = makeService(storedRow({ accessTokenExpiresAt: inMs(-1000) }));

    await service.getToken(USER_ID);
    await expect(service.getToken(USER_ID)).resolves.toBe("ghu_new");
    expect(tokenCalls()).toHaveLength(1);
  });

  it("asks for a reconnect when no token is stored", async () => {
    const { service } = makeService(null);

    const error = await service.getToken(USER_ID).catch((e: unknown) => e);
    expect(codeOf(error)).toBe("github_reconnect_required");
    expect((error as HttpError).status).toBe(409);
  });

  it("clears the tokens and asks for a reconnect when GitHub rejects the refresh", async () => {
    on(TOKEN_URL, { status: 200, body: { error: "bad_refresh_token" } });
    const { service, db } = makeService(storedRow({ accessTokenExpiresAt: inMs(-1000) }));

    const error = await service.getToken(USER_ID).catch((e: unknown) => e);

    expect(codeOf(error)).toBe("github_reconnect_required");
    expect(db.state.row).toMatchObject({ accessTokenEnc: null, refreshTokenEnc: null });
  });

  it("asks for a reconnect when the refresh token itself has expired", async () => {
    const { service } = makeService(
      storedRow({ accessTokenExpiresAt: inMs(-1000), refreshTokenExpiresAt: inMs(-1000) }),
    );

    expect(codeOf(await service.getToken(USER_ID).catch((e: unknown) => e))).toBe(
      "github_reconnect_required",
    );
    expect(tokenCalls()).toHaveLength(0);
  });

  it("clears the tokens when GitHub answers 401 to an API call", async () => {
    on(/\/user\/installations\?/, { status: 401, body: { message: "Bad credentials" } });
    const { service, db } = makeService();

    const error = await service.listInstallations(USER_ID).catch((e: unknown) => e);

    expect(codeOf(error)).toBe("github_reconnect_required");
    expect(db.state.row?.accessTokenEnc).toBeNull();
  });
});

const apiRepo = (id: number, owner = "owner") => ({
  id,
  full_name: `${owner}/repo-${id}`,
  name: `repo-${id}`,
  private: id % 2 === 0,
  default_branch: "main",
  pushed_at: "2026-10-01T00:00:00Z",
  owner: { login: owner },
});

/** Serves `total` repositories for an installation, 100 per page. */
function serveRepositories(installationId: number, total: number) {
  on(new RegExp(`/user/installations/${installationId}/repositories\\?`), (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const start = (page - 1) * 100;
    const count = Math.max(0, Math.min(100, total - start));
    return {
      status: 200,
      body: {
        total_count: total,
        repositories: Array.from({ length: count }, (_, i) => apiRepo(installationId * 10_000 + start + i)),
      },
    };
  });
}

describe("GithubUserService.listRepositories", () => {
  it("pages through every installation and maps the fields", async () => {
    on(/\/user\/installations\?/, {
      status: 200,
      body: {
        installations: [
          {
            id: 1,
            account: { login: "owner", type: "User" },
            repository_selection: "selected",
            html_url: "https://github.com/settings/installations/1",
          },
          {
            id: 2,
            account: { login: "acme", type: "Organization" },
            repository_selection: "all",
            html_url: "https://github.com/organizations/acme/settings/installations/2",
          },
        ],
      },
    });
    serveRepositories(1, 250);
    serveRepositories(2, 3);
    const { service } = makeService();

    const listing = await service.listRepositories(USER_ID);

    expect(listing.installations).toEqual([
      {
        id: "1",
        account: "owner",
        accountType: "User",
        repositorySelection: "selected",
        manageUrl: "https://github.com/settings/installations/1",
      },
      {
        id: "2",
        account: "acme",
        accountType: "Organization",
        repositorySelection: "all",
        manageUrl: "https://github.com/organizations/acme/settings/installations/2",
      },
    ]);
    expect(listing.repositories).toHaveLength(253);
    expect(listing.truncated).toBe(false);
    expect(listing.repositories[0]).toEqual({
      id: 10_000,
      fullName: "owner/repo-10000",
      owner: "owner",
      name: "repo-10000",
      private: true,
      defaultBranch: "main",
      installationId: "1",
      pushedAt: "2026-10-01T00:00:00Z",
    });
  });

  it("stops at five pages per installation and reports truncated", async () => {
    on(/\/user\/installations\?/, {
      status: 200,
      body: {
        installations: [
          { id: 1, account: { login: "owner", type: "User" }, repository_selection: "all", html_url: "x" },
        ],
      },
    });
    serveRepositories(1, 720);
    const { service } = makeService();

    const listing = await service.listRepositories(USER_ID);

    expect(listing.repositories).toHaveLength(500);
    expect(listing.truncated).toBe(true);
  });

  it("sends the user's token", async () => {
    on(/\/user\/installations\?/, { status: 200, body: { installations: [] } });
    const { service } = makeService();

    await service.listRepositories(USER_ID);

    expect(mockFetch.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({ authorization: "Bearer ghu_old" }),
    });
  });
});

describe("GithubUserService.canAccess", () => {
  it("is true when the user can read the repository", async () => {
    on("https://api.github.com/repos/owner/repo", { status: 200, body: { id: 1 } });

    await expect(makeService().service.canAccess(USER_ID, REPO)).resolves.toBe(true);
  });

  it("is false when GitHub answers 404", async () => {
    on("https://api.github.com/repos/owner/repo", { status: 404, body: { message: "Not Found" } });

    await expect(makeService().service.canAccess(USER_ID, REPO)).resolves.toBe(false);
  });

  it("throws on any other answer rather than guessing", async () => {
    on("https://api.github.com/repos/owner/repo", { status: 500, body: {} });

    await expect(makeService().service.canAccess(USER_ID, REPO)).rejects.toMatchObject({ status: 502 });
  });
});

describe("GithubUserService.listBranches", () => {
  it("lists branches with the default branch", async () => {
    on("https://api.github.com/repos/owner/repo", { status: 200, body: { default_branch: "main" } });
    on(/\/repos\/owner\/repo\/branches\?/, {
      status: 200,
      body: [
        { name: "develop", protected: false },
        { name: "main", protected: true },
      ],
    });

    await expect(makeService().service.listBranches(USER_ID, REPO)).resolves.toEqual({
      defaultBranch: "main",
      branches: [
        { name: "develop", protected: false },
        { name: "main", protected: true },
      ],
    });
  });

  it("keeps the default branch when the page cap hides it", async () => {
    on("https://api.github.com/repos/owner/repo", { status: 200, body: { default_branch: "zzz" } });
    on(/\/repos\/owner\/repo\/branches\?/, () => ({
      status: 200,
      body: Array.from({ length: 100 }, (_, i) => ({ name: `b${i}`, protected: false })),
    }));

    const listing = await makeService().service.listBranches(USER_ID, REPO);

    expect(listing.branches).toHaveLength(301);
    expect(listing.branches[0]).toEqual({ name: "zzz", protected: false });
  });

  it("answers 404 for a repository the user cannot see", async () => {
    on("https://api.github.com/repos/owner/repo", { status: 404, body: {} });

    await expect(makeService().service.listBranches(USER_ID, REPO)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });
});
