import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@orbitops/integration-common/provider-error";
import { buildApp, type AppDeps } from "../app";
import type { Db } from "../db";
import { RenderLogProxy } from "./log-proxy";

const INTERNAL = "i".repeat(40);
const PROXY = "p".repeat(40);
const KEY = "rnd_key_never_leaves_this_service";

const db = {
  renderService: { findUnique: vi.fn(async () => ({ componentId: "c1", userId: "u1", renderServiceId: "srv-1", ownerId: "tea-1" })) },
} as unknown as Db;
const credentials = { getKey: vi.fn(async () => ({ apiKey: KEY })), markInvalid: vi.fn(async () => undefined) };

afterEach(() => vi.unstubAllGlobals());

describe("RenderLogProxy", () => {
  it("reads one /v1/logs page for the component's own service, with fixed owner, resource and direction", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ logs: [], hasMore: false }), { status: 200, headers: { "ratelimit-remaining": "42" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new RenderLogProxy(db, credentials as never).logsPage(
      "u1",
      "c1",
      { types: ["app", "request", "build"], startTime: "2026-11-04T10:00:00Z", limit: 500 },
      new AbortController().signal,
    );
    expect(result).toEqual({ body: { logs: [], hasMore: false }, rateLimit: { "ratelimit-remaining": "42" } });
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.pathname).toBe("/v1/logs");
    expect(url.searchParams.get("ownerId")).toBe("tea-1");
    expect(url.searchParams.getAll("resource")).toEqual(["srv-1"]);
    expect(url.searchParams.getAll("type")).toEqual(["app", "request"]);
    expect(url.searchParams.get("direction")).toBe("forward");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses another user's component and maps 401 and 429", async () => {
    const proxy = new RenderLogProxy(db, credentials as never);
    await expect(proxy.logsPage("u2", "c1", { types: ["app"], startTime: "2026-11-04T10:00:00Z", limit: 10 }, new AbortController().signal)).rejects.toMatchObject({
      status: 404,
      code: "not_deployed",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(proxy.logsPage("u1", "c1", { types: ["app"], startTime: "2026-11-04T10:00:00Z", limit: 10 }, new AbortController().signal)).rejects.toMatchObject({
      status: 412,
      code: "render_key_invalid",
    });
    expect(credentials.markInvalid).toHaveBeenCalledWith("u1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "5" } })));
    await expect(proxy.logsPage("u1", "c1", { types: ["app"], startTime: "2026-11-04T10:00:00Z", limit: 10 }, new AbortController().signal)).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe("/log-proxy route", () => {
  function app(overrides: Partial<AppDeps> = {}) {
    const logProxy = { logsPage: vi.fn(async () => ({ body: { logs: [{ id: "l1" }] }, rateLimit: { "ratelimit-remaining": "9" } })) };
    const deps = {
      serviceToken: INTERNAL,
      credentials: {} as AppDeps["credentials"],
      deployments: {} as AppDeps["deployments"],
      logProxy,
      logsProxyToken: PROXY,
      ...overrides,
    } as AppDeps;
    return { server: buildApp(deps), logProxy };
  }
  const url = "/log-proxy/components/c1/logs?userId=u1&type=app&type=request&startTime=2026-11-04T10:00:00Z";

  it("returns the page and the rate-limit headers", async () => {
    const { server, logProxy } = app();
    const res = await server.inject({ method: "GET", url, headers: { "x-logs-token": PROXY } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ logs: [{ id: "l1" }] });
    expect(res.headers["ratelimit-remaining"]).toBe("9");
    expect(logProxy.logsPage.mock.calls[0]).toEqual([
      "u1",
      "c1",
      { types: ["app", "request"], startTime: "2026-11-04T10:00:00Z", limit: 100, direction: "forward" },
      expect.any(AbortSignal),
    ]);
  });

  it("keeps the two tokens apart, and is off without LOGS_PROXY_TOKEN", async () => {
    const { server, logProxy } = app();
    expect((await server.inject({ method: "GET", url, headers: { "x-internal-token": INTERNAL } })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/deployments?state=active", headers: { "x-logs-token": PROXY } })).statusCode).toBe(401);
    expect(logProxy.logsPage).not.toHaveBeenCalled();
    expect((await app({ logsProxyToken: undefined }).server.inject({ method: "GET", url, headers: { "x-logs-token": PROXY } })).statusCode).toBe(503);
  });

  it("maps a refusal to its status and code", async () => {
    const { server, logProxy } = app();
    logProxy.logsPage.mockRejectedValueOnce(new ProviderError("No Render service yet.", 404, "not_deployed"));
    const res = await server.inject({ method: "GET", url, headers: { "x-logs-token": PROXY } });
    expect(res.json()).toEqual({ error: "not_deployed", message: "No Render service yet." });
  });
});
