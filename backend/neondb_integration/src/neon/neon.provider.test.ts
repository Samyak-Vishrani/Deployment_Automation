import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNeonApiBase } from "./neon-http";
import { NeonProvider } from "./neon.provider";

const BASE = "https://neon.test/api/v2";
const ctx = { apiKey: "napi_test_key_0123456789" };

type Route = (url: URL, init: RequestInit) => Response | undefined;

/** A fake Neon API: each call goes to the first route that answers. */
function stubNeon(...routes: Route[]) {
  const calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push({
      method: init.method ?? "GET",
      path: url.pathname.replace("/api/v2", ""),
      search: url.search,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const on =
  (method: string, path: string | RegExp, respond: (url: URL, init: RequestInit) => Response): Route =>
  (url, init) => {
    const p = url.pathname.replace("/api/v2", "");
    const matches = typeof path === "string" ? p === path : path.test(p);
    return (init.method ?? "GET") === method && matches ? respond(url, init) : undefined;
  };

const CREATED = {
  project: { id: "young-sun-123", name: "shop-database", region_id: "aws-us-west-2", pg_version: 17, org_id: "org-1" },
  branch: { id: "br-main-1" },
  databases: [{ name: "neondb", owner_name: "neondb_owner", branch_id: "br-main-1" }],
  roles: [{ name: "neondb_owner", protected: false }],
  endpoints: [{ host: "ep-cool-1.us-west-2.aws.neon.tech" }],
  connection_uris: [{ connection_uri: "postgresql://neondb_owner:npg_pw@ep-cool-1/neondb" }],
  operations: [{ id: "op1", action: "create_timeline", status: "running" }],
};

let now = 0;
function provider() {
  return new NeonProvider({
    pollIntervalMs: 1000,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  });
}

beforeEach(() => {
  now = 1_000_000;
  setNeonApiBase(BASE);
});
afterEach(() => vi.unstubAllGlobals());

describe("validateKey", () => {
  it("reads the account and its organizations", async () => {
    stubNeon(
      on("GET", "/users/me", () => json(200, { name: "Samyak", last_name: "V", email: "s@example.com" })),
      on("GET", "/users/me/organizations", () => json(200, { organizations: [{ id: "org-1", name: "Personal" }, { name: "no id" }] })),
    );
    await expect(provider().validateKey(ctx.apiKey)).resolves.toEqual({
      accountName: "Samyak V",
      orgs: [{ id: "org-1", name: "Personal" }],
    });
  });

  it("rejects a bad key as neon_key_invalid", async () => {
    stubNeon(on("GET", "/users/me", () => json(401, { message: "invalid API key" })));
    await expect(provider().validateKey("bad")).rejects.toMatchObject({ code: "neon_key_invalid", invalidToken: true });
  });

  it("accepts an organization key that cannot read /users/me, by listing projects", async () => {
    const calls = stubNeon(
      on("GET", "/users/me", () => json(404, { message: "not found" })),
      on("GET", "/projects", () => json(200, { projects: [] })),
    );
    const account = await provider().validateKey(ctx.apiKey);
    expect(account).toEqual({ accountName: "Neon organization key", orgs: [] });
    expect(calls.map((c) => c.path)).toEqual(["/users/me", "/projects", "/users/me/organizations"]);
  });
});

describe("createProject", () => {
  const spec = { name: "shop-database", regionId: "aws-us-west-2", pgVersion: 17, orgId: "org-1" };

  it("creates with region, version and org, and returns what is needed later", async () => {
    const calls = stubNeon(on("POST", "/projects", () => json(201, CREATED)));
    await expect(provider().createProject(ctx, spec)).resolves.toEqual({
      neonProjectId: "young-sun-123",
      name: "shop-database",
      regionId: "aws-us-west-2",
      pgVersion: 17,
      orgId: "org-1",
      branchId: "br-main-1",
      databaseName: "neondb",
      roleName: "neondb_owner",
      host: "ep-cool-1.us-west-2.aws.neon.tech",
    });
    expect(calls[0].body).toEqual({
      project: { name: "shop-database", region_id: "aws-us-west-2", pg_version: 17, org_id: "org-1" },
    });
  });

  it("leaves org_id out when none is chosen", async () => {
    const calls = stubNeon(on("POST", "/projects", () => json(201, CREATED)));
    await provider().createProject(ctx, { ...spec, orgId: null });
    expect((calls[0].body as { project: Record<string, unknown> }).project).not.toHaveProperty("org_id");
  });

  it("retries a name conflict once with a suffix", async () => {
    let first = true;
    const calls = stubNeon(
      on("POST", "/projects", () => {
        if (first) {
          first = false;
          return json(409, { message: "project with this name already exists" });
        }
        return json(201, CREATED);
      }),
    );
    await provider().createProject(ctx, spec);
    const names = calls.map((c) => (c.body as { project: { name: string } }).project.name);
    expect(names[0]).toBe("shop-database");
    expect(names[1]).toMatch(/^shop-database-[0-9a-f]{4}$/);
  });

  it("maps the plan's project limit", async () => {
    stubNeon(on("POST", "/projects", () => json(422, { message: "projects limit exceeded for this plan" })));
    await expect(provider().createProject(ctx, spec)).rejects.toMatchObject({ code: "neon_project_limit" });
  });

  it("falls back to the connection parameters for names, and refuses an answer without ids", async () => {
    stubNeon(
      on("POST", "/projects", () =>
        json(201, {
          project: { id: "p2" },
          branch: { id: "br2" },
          connection_uris: [{ connection_parameters: { database: "appdb", role: "app_owner", host: "ep-2" } }],
        }),
      ),
    );
    await expect(provider().createProject(ctx, spec)).resolves.toMatchObject({
      databaseName: "appdb",
      roleName: "app_owner",
      host: "ep-2",
    });

    stubNeon(on("POST", "/projects", () => json(201, { project: {} })));
    await expect(provider().createProject(ctx, spec)).rejects.toMatchObject({ code: "neon_unexpected_response" });
  });
});

describe("findProject and deleteProject", () => {
  it("returns null for a project deleted on Neon", async () => {
    stubNeon(on("GET", "/projects/gone", () => json(404, { message: "project not found" })));
    await expect(provider().findProject(ctx, "gone")).resolves.toBeNull();
  });

  it("treats deleting a missing project as done", async () => {
    stubNeon(on("DELETE", "/projects/gone", () => json(404, {})));
    await expect(provider().deleteProject(ctx, "gone")).resolves.toBeUndefined();
  });
});

describe("waitForOperations", () => {
  it("polls until every operation has finished", async () => {
    const answers = [
      [{ status: "running", action: "create_timeline" }],
      [{ status: "finished" }, { status: "scheduling" }],
      [{ status: "finished" }, { status: "finished" }],
    ];
    const calls = stubNeon(on("GET", "/projects/p1/operations", () => json(200, { operations: answers.shift() })));
    await provider().waitForOperations(ctx, "p1", { timeoutMs: 60_000 });
    expect(calls).toHaveLength(3);
  });

  it("waits out a 423", async () => {
    const answers = [json(423, { message: "locked" }), json(200, { operations: [{ status: "finished" }] })];
    stubNeon(on("GET", "/projects/p1/operations", () => answers.shift()!));
    await expect(provider().waitForOperations(ctx, "p1", { timeoutMs: 60_000 })).resolves.toBeUndefined();
  });

  it("reports a failed operation", async () => {
    stubNeon(
      on("GET", "/projects/p1/operations", () =>
        json(200, { operations: [{ status: "failed", action: "start_compute", error: "no capacity" }] }),
      ),
    );
    await expect(provider().waitForOperations(ctx, "p1", { timeoutMs: 60_000 })).rejects.toMatchObject({
      code: "neon_provision_failed",
      message: expect.stringContaining("start compute failed: no capacity"),
    });
  });

  it("ignores old failures when given a start time", async () => {
    stubNeon(
      on("GET", "/projects/p1/operations", () =>
        json(200, {
          operations: [
            { status: "failed", created_at: new Date(now - 3_600_000).toISOString() },
            { status: "finished", created_at: new Date(now).toISOString() },
          ],
        }),
      ),
    );
    await expect(provider().waitForOperations(ctx, "p1", { timeoutMs: 60_000, since: now })).resolves.toBeUndefined();
  });

  it("gives up with neon_provision_timeout", async () => {
    stubNeon(on("GET", "/projects/p1/operations", () => json(200, { operations: [{ status: "running" }] })));
    await expect(provider().waitForOperations(ctx, "p1", { timeoutMs: 5_000 })).rejects.toMatchObject({
      code: "neon_provision_timeout",
      status: 504,
    });
  });
});

describe("getConnection", () => {
  const ref = { neonProjectId: "p1", branchId: "br1", databaseName: "neondb", roleName: "neondb_owner" };

  it("asks for the pooled and the direct URI of the right branch, database and role", async () => {
    const calls = stubNeon(
      on("GET", "/projects/p1/connection_uri", (url) =>
        json(200, {
          uri:
            url.searchParams.get("pooled") === "true"
              ? "postgresql://neondb_owner:pw@ep-1-pooler.neon.tech/neondb"
              : "postgresql://neondb_owner:pw@ep-1.neon.tech/neondb",
        }),
      ),
    );
    await expect(provider().getConnection(ctx, ref)).resolves.toEqual({
      pooledUri: "postgresql://neondb_owner:pw@ep-1-pooler.neon.tech/neondb",
      directUri: "postgresql://neondb_owner:pw@ep-1.neon.tech/neondb",
    });
    expect(calls[0].search).toBe("?branch_id=br1&database_name=neondb&role_name=neondb_owner&pooled=true");
    expect(calls[1].search).toContain("pooled=false");
  });

  it("waits out a 423, and refuses something that is not a Postgres URI", async () => {
    const answers = [json(423, {}), json(200, { uri: "postgresql://u:p@h/db" }), json(200, { uri: "https://evil" })];
    stubNeon(on("GET", "/projects/p1/connection_uri", () => answers.shift()!));
    await expect(provider().getConnection(ctx, ref)).rejects.toMatchObject({ code: "neon_unexpected_response" });
  });

  it("says the database is gone on a 404", async () => {
    stubNeon(on("GET", "/projects/p1/connection_uri", () => json(404, { message: "role not found" })));
    await expect(provider().getConnection(ctx, ref)).rejects.toMatchObject({ code: "neon_database_gone" });
  });
});
