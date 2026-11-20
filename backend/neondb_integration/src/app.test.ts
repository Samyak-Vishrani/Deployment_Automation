import { ProviderError } from "@orbitops/integration-common/provider-error";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDeps } from "./app";

const SECRET = "n".repeat(40);
const URIS = {
  pooledUri: "postgresql://neondb_owner:npg_pw@ep-1-pooler.neon.tech/neondb",
  directUri: "postgresql://neondb_owner:npg_pw@ep-1.neon.tech/neondb",
};

function app(overrides: Partial<AppDeps> = {}) {
  const deps: AppDeps = {
    serviceToken: SECRET,
    credentials: {
      get: vi.fn(async () => ({ provider: "neon", state: "missing" }) as never),
      save: vi.fn(async () => ({ provider: "neon", state: "connected" }) as never),
      setPreferences: vi.fn(async () => ({ provider: "neon", state: "connected", regionId: "aws-eu-central-1" }) as never),
      remove: vi.fn(async () => ({ deleted: true })),
    },
    databases: {
      ensure: vi.fn(async (request) => ({ componentId: request.componentId, state: "ready", created: true }) as never),
      get: vi.fn(async () => ({ componentId: "c1", state: "ready" }) as never),
      connection: vi.fn(async () => URIS),
      destroy: vi.fn(async () => ({ deleted: true })),
    },
    checkDatabase: async () => true,
    ...overrides,
  };
  return { deps, server: buildApp(deps) };
}

const auth = { "x-internal-token": SECRET };

describe("internal API", () => {
  it("serves /health without a token", async () => {
    const res = await app().server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", database: true });
  });

  it("rejects every other route without the right token", async () => {
    const { server } = app();
    for (const url of ["/users/u1/credential", "/databases/c1?userId=u1", "/databases/c1/connection?userId=u1", "/options"]) {
      expect((await server.inject({ method: "GET", url })).statusCode).toBe(401);
      expect((await server.inject({ method: "GET", url, headers: { "x-internal-token": "wrong" } })).statusCode).toBe(401);
    }
  });

  it("saves a key and passes preferences through", async () => {
    const { deps, server } = app();
    const saved = await server.inject({ method: "PUT", url: "/users/u1/credential", headers: auth, payload: { apiKey: "napi_x" } });
    expect(saved.statusCode).toBe(200);
    expect(deps.credentials.save).toHaveBeenCalledWith("u1", "napi_x");

    const bad = await server.inject({ method: "PATCH", url: "/users/u1/credential", headers: auth, payload: { regionId: "mars" } });
    expect(bad.statusCode).toBe(400);
    const ok = await server.inject({ method: "PATCH", url: "/users/u1/credential", headers: auth, payload: { regionId: "aws-eu-central-1" } });
    expect(ok.json()).toMatchObject({ regionId: "aws-eu-central-1" });
  });

  it("provisions synchronously and validates the request", async () => {
    const { deps, server } = app();
    const body = { userId: "u1", componentId: "c1", projectName: "shop", componentName: "database" };
    const res = await server.inject({ method: "POST", url: "/databases", headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ componentId: "c1", state: "ready" });
    expect(deps.databases.ensure).toHaveBeenCalledWith(body);

    const bad = await server.inject({ method: "POST", url: "/databases", headers: auth, payload: { ...body, userId: "a b" } });
    expect(bad.statusCode).toBe(400);
  });

  it("returns connection strings uncached, and requires a userId", async () => {
    const { server } = app();
    const res = await server.inject({ method: "GET", url: "/databases/c1/connection?userId=u1", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual(URIS);

    expect((await server.inject({ method: "GET", url: "/databases/c1/connection", headers: auth })).statusCode).toBe(400);
  });

  it("maps provider errors to their status and code, without leaking anything else", async () => {
    const { server } = app({
      databases: {
        ensure: vi.fn(async () => {
          throw new ProviderError("Neon's plan limit is reached.", 409, "neon_project_limit");
        }),
        get: vi.fn(),
        connection: vi.fn(),
        destroy: vi.fn(),
      },
    });
    const res = await server.inject({
      method: "POST",
      url: "/databases",
      headers: auth,
      payload: { userId: "u1", componentId: "c1", projectName: "shop", componentName: "database" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "neon_project_limit", message: "Neon's plan limit is reached." });
  });

  it("lists the regions and versions Settings offers", async () => {
    const res = await app().server.inject({ method: "GET", url: "/options", headers: auth });
    expect(res.json().regions.map((r: { id: string }) => r.id)).toContain("aws-us-west-2");
    expect(res.json().pgVersions).toEqual([15, 16, 17]);
  });
});
