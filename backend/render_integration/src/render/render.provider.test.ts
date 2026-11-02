import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentSpec, RepoSpec } from "../types";
import { envHash, toEnvVars } from "./env-vars";
import { setRenderApiBase } from "./render-http";
import { RenderProvider, type KnownService } from "./render.provider";
import { settingsHash, toServiceSettings } from "./service-settings";

/**
 * A fake Render API: each test lists the responses for "METHOD /path" in order;
 * every call is recorded with its parsed JSON body and query.
 */
type Handler = { status: number; body?: unknown };
let routes: Map<string, Handler[]>;
let calls: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }>;

function on(method: string, path: string, ...responses: Handler[]) {
  routes.set(`${method} ${path}`, [...(routes.get(`${method} ${path}`) ?? []), ...responses]);
}

beforeEach(() => {
  setRenderApiBase("https://render.test/v1");
  routes = new Map();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const method = (init.method ?? "GET").toUpperCase();
      const path = url.pathname.replace(/^\/v1/, "");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, query: url.searchParams, body });
      const queue = routes.get(`${method} ${path}`);
      const handler = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      if (!handler) return new Response(JSON.stringify({ message: `not mocked: ${method} ${path}` }), { status: 500 });
      return new Response(handler.body === undefined ? null : JSON.stringify(handler.body), { status: handler.status });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const ctx = { apiKey: "rnd_key_1234567890" };
const repo: RepoSpec = { fullName: "me/shop", branch: "main" };
const component: ComponentSpec = {
  id: "comp1",
  name: "api",
  rootDir: "backend",
  framework: "express",
  installCmd: "npm install",
  buildCmd: null,
  startCmd: "npm start",
  nodeVersion: "20",
  healthCheckPath: "/health",
};
const defaults = { ownerId: "own_1", region: "oregon", plan: "free" };
const env = [{ key: "GREETING", value: "hi-secret-value" }];
const SHA = "a".repeat(40);
const log = () => undefined;
const noSleep = async () => undefined;

const knownFor = (overrides: Partial<KnownService> = {}): KnownService => {
  const settings = toServiceSettings(component, repo, defaults);
  return {
    renderServiceId: "srv-1",
    name: "shop-api",
    ownerId: "own_1",
    region: "oregon",
    plan: "free",
    runtime: "node",
    url: "https://shop-api.onrender.com",
    dashboardUrl: "https://dashboard.render.com/web/srv-1",
    settingsHash: settingsHash(settings),
    envHash: envHash(toEnvVars(env, component, "node")),
    managedEnvKeys: ["GREETING", "NODE_VERSION"],
    ...overrides,
  };
};

describe("validateCredentials", () => {
  it("lists the workspaces and picks the personal one as the account name", async () => {
    on("GET", "/owners", {
      status: 200,
      body: [
        { owner: { id: "tea_1", name: "Club", type: "team" }, cursor: "c1" },
        { owner: { id: "usr_1", name: "samyak", email: "s@x.dev", type: "user" }, cursor: "c2" },
      ],
    });
    const account = await new RenderProvider(noSleep).validateCredentials("key");
    expect(account).toEqual({
      accountName: "samyak",
      owners: [
        { id: "tea_1", name: "Club", type: "team" },
        { id: "usr_1", name: "samyak", type: "user" },
      ],
    });
  });

  it("rejects a bad key", async () => {
    on("GET", "/owners", { status: 401, body: { message: "unauthorized" } });
    await expect(new RenderProvider(noSleep).validateCredentials("bad")).rejects.toMatchObject({ code: "render_key_invalid" });
  });
});

describe("ensureService", () => {
  it("creates a web service with auto-deploy off, env vars and the workspace defaults", async () => {
    on("POST", "/services", {
      status: 201,
      body: { service: { id: "srv-1", name: "shop-api", serviceDetails: { url: "https://shop-api.onrender.com" } }, deployId: "dep-0" },
    });
    const service = await new RenderProvider(noSleep).ensureService(ctx, null, component, repo, defaults, env, log);

    expect(service).toMatchObject({
      renderServiceId: "srv-1",
      url: "https://shop-api.onrender.com",
      created: true,
      initialDeployId: "dep-0",
      managedEnvKeys: ["GREETING", "NODE_VERSION"],
    });
    expect(calls[0].body).toMatchObject({
      type: "web_service",
      ownerId: "own_1",
      repo: "https://github.com/me/shop",
      branch: "main",
      rootDir: "backend",
      autoDeployTrigger: "off",
      envVars: [
        { key: "GREETING", value: "hi-secret-value" },
        { key: "NODE_VERSION", value: "20" },
      ],
      serviceDetails: { runtime: "node", plan: "free", region: "oregon", healthCheckPath: "/health" },
    });
  });

  it("picks another name when the first is taken", async () => {
    on(
      "POST",
      "/services",
      { status: 409, body: { message: "name taken" } },
      { status: 201, body: { service: { id: "srv-2", name: "shop-api-ab12" }, deployId: "dep-0" } },
    );
    await new RenderProvider(noSleep).ensureService(ctx, null, component, repo, defaults, env, log);
    expect((calls[1].body as { name: string }).name).toMatch(/^shop-api-[a-z0-9]{4}$/);
  });

  it("reports a repository Render cannot read", async () => {
    on("POST", "/services", { status: 400, body: { message: "could not access repository" } });
    await expect(
      new RenderProvider(noSleep).ensureService(ctx, null, component, repo, defaults, env, log),
    ).rejects.toMatchObject({ code: "render_repo_access" });
  });

  it("does nothing but look the service up when settings and env are unchanged", async () => {
    on("GET", "/services/srv-1", { status: 200, body: { id: "srv-1", serviceDetails: { url: "https://shop-api.onrender.com" } } });
    const service = await new RenderProvider(noSleep).ensureService(ctx, knownFor(), component, repo, defaults, env, log);
    expect(service.created).toBe(false);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /services/srv-1"]);
  });

  it("PATCHes changed settings and syncs changed env vars, deleting only managed keys that are gone", async () => {
    on("GET", "/services/srv-1", { status: 200, body: { id: "srv-1" } });
    on("PATCH", "/services/srv-1", { status: 200, body: {} });
    on("PUT", "/services/srv-1/env-vars/NEW_KEY", { status: 200, body: {} });
    on("PUT", "/services/srv-1/env-vars/NODE_VERSION", { status: 200, body: {} });
    on("DELETE", "/services/srv-1/env-vars/GREETING", { status: 204 });

    const changed = { ...component, startCmd: "node dist/main" };
    const service = await new RenderProvider(noSleep).ensureService(
      ctx,
      knownFor(),
      changed,
      repo,
      defaults,
      [{ key: "NEW_KEY", value: "v" }],
      log,
    );

    const made = calls.map((c) => `${c.method} ${c.path}`);
    expect(made).toEqual([
      "GET /services/srv-1",
      "PATCH /services/srv-1",
      "PUT /services/srv-1/env-vars/NEW_KEY",
      "PUT /services/srv-1/env-vars/NODE_VERSION",
      "DELETE /services/srv-1/env-vars/GREETING",
    ]);
    expect(calls[1].body).toMatchObject({ serviceDetails: { envSpecificDetails: { startCommand: "node dist/main" } } });
    expect(service.managedEnvKeys).toEqual(["NEW_KEY", "NODE_VERSION"]);
  });

  it("recreates a service that was deleted on Render", async () => {
    on("GET", "/services/srv-1", { status: 404, body: { message: "not found" } });
    on("POST", "/services", { status: 201, body: { service: { id: "srv-9", name: "shop-api" }, deployId: "dep-0" } });
    const service = await new RenderProvider(noSleep).ensureService(ctx, knownFor(), component, repo, defaults, env, log);
    expect(service).toMatchObject({ renderServiceId: "srv-9", created: true });
  });
});

describe("deploy", () => {
  it("adopts the deploy Render started at creation when it builds our commit", async () => {
    on("GET", "/services/srv-1/deploys/dep-0", { status: 200, body: { id: "dep-0", status: "build_in_progress", commit: { id: SHA } } });
    const result = await new RenderProvider(noSleep).deploy(ctx, "srv-1", SHA, "dep-0", log);
    expect(result).toMatchObject({ providerDeploymentId: "dep-0", adopted: true });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("cancels an initial deploy of another commit and deploys the exact SHA", async () => {
    on("GET", "/services/srv-1/deploys/dep-0", { status: 200, body: { id: "dep-0", commit: { id: "b".repeat(40) } } });
    on("POST", "/services/srv-1/deploys/dep-0/cancel", { status: 200, body: {} });
    on("POST", "/services/srv-1/deploys", { status: 201, body: { id: "dep-1", status: "created" } });

    const result = await new RenderProvider(noSleep).deploy(ctx, "srv-1", SHA, "dep-0", log);
    expect(result).toMatchObject({
      providerDeploymentId: "dep-1",
      adopted: false,
      dashboardUrl: "https://dashboard.render.com/web/srv-1/deploys/dep-1",
    });
    expect(calls.find((c) => c.path === "/services/srv-1/deploys")?.body).toEqual({ commitId: SHA, clearCache: "do_not_clear" });
  });
});

describe("observe and manage", () => {
  it("normalises status and keeps Render's word", async () => {
    on("GET", "/services/srv-1/deploys/dep-1", { status: 200, body: { id: "dep-1", status: "update_failed" } });
    await expect(new RenderProvider(noSleep).getStatus(ctx, "srv-1", "dep-1")).resolves.toEqual({
      status: "failed",
      rawStatus: "update_failed",
    });
  });

  it("follows log pages and returns a cursor", async () => {
    on(
      "GET",
      "/logs",
      {
        status: 200,
        body: { hasMore: true, nextStartTime: "2026-11-03T10:00:02Z", logs: [{ id: "a", message: "one", timestamp: "2026-11-03T10:00:01Z" }] },
      },
      { status: 200, body: { hasMore: false, logs: [{ id: "b", message: "two", timestamp: "2026-11-03T10:00:03Z" }] } },
    );
    const { lines, cursor } = await new RenderProvider(noSleep).getLogs(ctx, "own_1", "srv-1", "2026-11-03T10:00:00Z");
    expect(lines.map((l) => l.text)).toEqual(["one", "two"]);
    expect(cursor).toBe("2026-11-03T10:00:03.000Z");
    expect(calls[0].query.getAll("resource")).toEqual(["srv-1"]);
    expect(calls[0].query.getAll("type")).toEqual(["build", "app"]);
    expect(calls[0].query.get("startTime")).toBe("2026-11-03T10:00:00Z");
    expect(calls[1].query.get("startTime")).toBe("2026-11-03T10:00:02Z");
  });

  it("treats cancelling a finished deploy as done", async () => {
    on("POST", "/services/srv-1/deploys/dep-1/cancel", { status: 409, body: { message: "already live" } });
    await expect(new RenderProvider(noSleep).cancel(ctx, "srv-1", "dep-1")).resolves.toBeUndefined();
  });

  it("rolls back and destroys", async () => {
    on("POST", "/services/srv-1/rollback", { status: 201, body: { id: "dep-r" } });
    on("DELETE", "/services/srv-1", { status: 204 });
    const provider = new RenderProvider(noSleep);
    await expect(provider.rollback(ctx, "srv-1", "dep-0")).resolves.toBe("dep-r");
    await expect(provider.destroy(ctx, "srv-1")).resolves.toBeUndefined();
    expect(calls[0].body).toEqual({ deployId: "dep-0" });
  });
});

describe("probeHealth", () => {
  it("retries while a free instance wakes up, and reports instead of failing", async () => {
    const statuses = [503, 503, 200];
    vi.mocked(fetch).mockImplementation(async () => new Response("ok", { status: statuses.shift() ?? 200 }));
    const lines: string[] = [];
    const sleep = vi.fn(async () => undefined);
    const healthy = await new RenderProvider(sleep).probeHealth("https://shop-api.onrender.com", "/health", (l) => lines.push(l), {
      attempts: 4,
    });
    expect(healthy).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(lines.at(-1)).toMatch(/GET https:\/\/shop-api\.onrender\.com\/health → HTTP 200/);
  });

  it("returns false with a note when the service never answers", async () => {
    vi.mocked(fetch).mockImplementation(async () => Promise.reject(new Error("timeout")));
    const lines: string[] = [];
    const healthy = await new RenderProvider(noSleep).probeHealth("https://x.onrender.com", null, (l) => lines.push(l), {
      attempts: 2,
    });
    expect(healthy).toBe(false);
    expect(lines.join("\n")).toMatch(/wake/);
  });
});
