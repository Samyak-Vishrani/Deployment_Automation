import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDeps } from "./app";
import { ProviderError } from "./http/provider-error";

const SECRET = "x".repeat(40);

function app(overrides: Partial<AppDeps> = {}) {
  const deps: AppDeps = {
    internalServiceToken: SECRET,
    credentials: {
      get: vi.fn(async () => ({ provider: "vercel", state: "missing" }) as never),
      save: vi.fn(async () => ({ provider: "vercel", state: "connected" }) as never),
      setTeam: vi.fn(),
      remove: vi.fn(async () => ({ deleted: true })),
    },
    deployments: {
      start: vi.fn(async (request) => ({ deploymentId: request.deploymentId, state: "queued" }) as never),
      get: vi.fn(),
      listActive: vi.fn(async () => []),
      cancel: vi.fn(),
      setEnv: vi.fn(),
      destroyProject: vi.fn(),
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
  component: { id: "comp1", name: "web", rootDir: "frontend", framework: "nextjs", installCmd: null, buildCmd: null, outputDir: null, nodeVersion: null },
  repo: { fullName: "me/shop", repoId: 42, branch: "main" },
  commitSha: "c".repeat(40),
  githubToken: "ghs_abc",
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

  it("validates a token before saving it, without echoing it", async () => {
    const { server, deps } = app();
    const res = await server.inject({ method: "PUT", url: "/users/user1/credential", headers: auth, payload: { token: "has space" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("has space");
    expect(deps.credentials.save).not.toHaveBeenCalled();

    const ok = await server.inject({ method: "PUT", url: "/users/user1/credential", headers: auth, payload: { token: "tok_123" } });
    expect(ok.statusCode).toBe(200);
    expect(deps.credentials.save).toHaveBeenCalledWith("user1", "tok_123");
  });

  it("accepts a deploy with 202 and rejects a malformed one", async () => {
    const { server, deps } = app();
    const accepted = await server.inject({ method: "POST", url: "/deployments", headers: auth, payload: deployBody });
    expect(accepted.statusCode).toBe(202);
    expect(deps.deployments.start).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: "dep1", githubToken: "ghs_abc" }));

    const bad = await server.inject({
      method: "POST",
      url: "/deployments",
      headers: auth,
      payload: { ...deployBody, component: { ...deployBody.component, rootDir: "../etc" } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/rootDir/);
  });

  it("maps provider errors onto their status and code", async () => {
    const { server } = app({
      credentials: {
        get: vi.fn(async () => {
          throw new ProviderError("Connect Vercel in Settings first.", 412, "vercel_not_connected");
        }),
        save: vi.fn(),
        setTeam: vi.fn(),
        remove: vi.fn(),
      },
    });
    const res = await server.inject({ method: "GET", url: "/users/user1/credential", headers: auth });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toEqual({ error: "vercel_not_connected", message: "Connect Vercel in Settings first." });
  });

  it("rejects an id-shaped path parameter that is not an id", async () => {
    const res = await app().server.inject({ method: "GET", url: "/users/a%20b/credential", headers: auth });
    expect(res.statusCode).toBe(400);
  });
});
