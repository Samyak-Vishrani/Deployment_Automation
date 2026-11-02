import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDeps } from "./app";
import { ProviderError } from "./http/provider-error";

const SECRET = "x".repeat(40);

function app(overrides: Partial<AppDeps> = {}) {
  const deps: AppDeps = {
    serviceToken: SECRET,
    credentials: {
      get: vi.fn(async () => ({ provider: "render", state: "missing" }) as never),
      save: vi.fn(async () => ({ provider: "render", state: "connected" }) as never),
      setPreferences: vi.fn(async () => ({ provider: "render", state: "connected", region: "frankfurt" }) as never),
      remove: vi.fn(async () => ({ deleted: true })),
    },
    deployments: {
      start: vi.fn(async (request) => ({ deploymentId: request.deploymentId, state: "queued" }) as never),
      get: vi.fn(),
      listActive: vi.fn(async () => []),
      cancel: vi.fn(),
      setEnv: vi.fn(async () => ({ updated: 1 })),
      rollback: vi.fn(async () => ({ renderDeployId: "dep-r" })),
      destroyService: vi.fn(),
    },
    checkDatabase: async () => true,
    ...overrides,
  };
  return { deps, server: buildApp(deps) };
}

const auth = { "x-internal-token": SECRET };

const deployBody = {
  deploymentId: "dep1",
  userId: "user1",
  component: {
    id: "comp1",
    name: "api",
    rootDir: "backend",
    framework: "express",
    installCmd: "npm install",
    buildCmd: null,
    startCmd: "npm start",
    nodeVersion: "20",
    healthCheckPath: "/health",
  },
  repo: { fullName: "me/shop", branch: "main" },
  commitSha: "c".repeat(40),
  envVars: [{ key: "API_SECRET", value: "secret-value-123" }],
};

describe("internal API", () => {
  it("serves /health without a token", async () => {
    const res = await app().server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", database: true });
  });

  it("rejects requests without the right internal token", async () => {
    const { server } = app();
    expect((await server.inject({ method: "GET", url: "/users/user1/credential" })).statusCode).toBe(401);
    expect(
      (await server.inject({ method: "GET", url: "/users/user1/credential", headers: { "x-internal-token": "wrong" } }))
        .statusCode,
    ).toBe(401);
    expect((await server.inject({ method: "GET", url: "/users/user1/credential", headers: auth })).statusCode).toBe(200);
  });

  it("validates an API key before saving it, without echoing it", async () => {
    const { server, deps } = app();
    const bad = await server.inject({ method: "PUT", url: "/users/user1/credential", headers: auth, payload: { apiKey: "has space" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("has space");
    expect(deps.credentials.save).not.toHaveBeenCalled();

    const ok = await server.inject({ method: "PUT", url: "/users/user1/credential", headers: auth, payload: { apiKey: "rnd_123" } });
    expect(ok.statusCode).toBe(200);
    expect(deps.credentials.save).toHaveBeenCalledWith("user1", "rnd_123");
  });

  it("saves workspace preferences and rejects unknown regions", async () => {
    const { server, deps } = app();
    const ok = await server.inject({ method: "PATCH", url: "/users/user1/credential", headers: auth, payload: { region: "frankfurt" } });
    expect(ok.statusCode).toBe(200);
    expect(deps.credentials.setPreferences).toHaveBeenCalledWith("user1", { region: "frankfurt" });
    const bad = await server.inject({ method: "PATCH", url: "/users/user1/credential", headers: auth, payload: { region: "mars" } });
    expect(bad.statusCode).toBe(400);
  });

  it("accepts a deploy with 202 and rejects malformed ones without echoing env values", async () => {
    const { server, deps } = app();
    const accepted = await server.inject({ method: "POST", url: "/deployments", headers: auth, payload: deployBody });
    expect(accepted.statusCode).toBe(202);
    expect(deps.deployments.start).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: "dep1", envVars: [{ key: "API_SECRET", value: "secret-value-123" }] }),
    );

    const badPath = await server.inject({
      method: "POST",
      url: "/deployments",
      headers: auth,
      payload: { ...deployBody, component: { ...deployBody.component, healthCheckPath: "health" } },
    });
    expect(badPath.statusCode).toBe(400);
    expect(badPath.json().message).toMatch(/healthCheckPath/);

    const badEnv = await server.inject({
      method: "POST",
      url: "/deployments",
      headers: auth,
      payload: { ...deployBody, envVars: [{ key: "1BAD", value: "secret-value-123" }] },
    });
    expect(badEnv.statusCode).toBe(400);
    expect(badEnv.body).not.toContain("secret-value-123");
  });

  it("maps provider errors onto their status and code", async () => {
    const { server } = app({
      credentials: {
        get: vi.fn(async () => {
          throw new ProviderError("Connect Render in Settings first.", 412, "render_not_connected");
        }),
        save: vi.fn(),
        setPreferences: vi.fn(),
        remove: vi.fn(),
      },
    });
    const res = await server.inject({ method: "GET", url: "/users/user1/credential", headers: auth });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toEqual({ error: "render_not_connected", message: "Connect Render in Settings first." });
  });

  it("serves the Phase 9 and Phase 11 hooks", async () => {
    const { server, deps } = app();
    const env = await server.inject({
      method: "PUT",
      url: "/components/comp1/env?userId=user1",
      headers: auth,
      payload: { vars: [{ key: "A", value: "1" }] },
    });
    expect(env.statusCode).toBe(200);
    expect(deps.deployments.setEnv).toHaveBeenCalledWith("user1", "comp1", [{ key: "A", value: "1" }]);

    const rollback = await server.inject({
      method: "POST",
      url: "/components/comp1/rollback?userId=user1",
      headers: auth,
      payload: { renderDeployId: "dep-old" },
    });
    expect(rollback.json()).toEqual({ renderDeployId: "dep-r" });
  });
});
