import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDeps } from "../app";
import type { Db } from "../db";
import { VercelLogProxy } from "./log-proxy";

const INTERNAL = "i".repeat(40);
const PROXY = "p".repeat(40);
const TOKEN = "vercel_token_never_leaves_1234";

function fakeDb(live = true) {
  return {
    vercelProject: { findUnique: vi.fn(async () => ({ componentId: "c1", userId: "u1", vercelProjectId: "prj_1" })) },
    vercelDeployment: {
      findFirst: vi.fn(async () => (live ? { componentId: "c1", userId: "u1", state: "live", vercelDeploymentId: "dpl_9" } : null)),
    },
  } as unknown as Db;
}
const credentials = { getToken: vi.fn(async () => ({ token: TOKEN, teamId: "team_1" })), markInvalid: vi.fn(async () => undefined) };

describe("VercelLogProxy", () => {
  it("opens the runtime-log stream of the live deployment, built from stored ids, with the token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}\n", { status: 200 })) as unknown as typeof fetch;
    const proxy = new VercelLogProxy(fakeDb(), credentials, fetchImpl);
    const { vercelDeploymentId } = await proxy.openRuntime("u1", "c1", new AbortController().signal);
    expect(vercelDeploymentId).toBe("dpl_9");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://api.vercel.com/v1/projects/prj_1/deployments/dpl_9/runtime-logs?teamId=team_1");
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it("answers not_deployed when nothing is live, and marks a rejected token invalid", async () => {
    const proxy = new VercelLogProxy(fakeDb(false), credentials, vi.fn() as unknown as typeof fetch);
    await expect(proxy.openRuntime("u1", "c1", new AbortController().signal)).rejects.toMatchObject({ status: 404, code: "not_deployed" });
    await expect(proxy.openRuntime("u2", "c1", new AbortController().signal)).rejects.toMatchObject({ code: "not_deployed" });

    const rejected = new VercelLogProxy(fakeDb(), credentials, (async () => new Response("", { status: 401 })) as unknown as typeof fetch);
    await expect(rejected.openRuntime("u1", "c1", new AbortController().signal)).rejects.toMatchObject({ status: 412, code: "vercel_token_invalid" });
    expect(credentials.markInvalid).toHaveBeenCalledWith("u1");
  });
});

describe("/log-proxy route", () => {
  function app(overrides: Partial<AppDeps> = {}) {
    const logProxy = {
      openRuntime: vi.fn(async () => ({
        body: new Response('{"rowId":"r1","message":"hi"}\n{"rowId":"r2"').body!,
        vercelDeploymentId: "dpl_9",
      })),
    };
    const deps = {
      internalServiceToken: INTERNAL,
      credentials: {} as AppDeps["credentials"],
      deployments: {} as AppDeps["deployments"],
      logProxy,
      logsProxyToken: PROXY,
      ...overrides,
    } as AppDeps;
    return { server: buildApp(deps), logProxy };
  }
  const url = "/log-proxy/components/c1/runtime-logs?userId=u1";

  it("pipes the stream back unchanged with the logs-proxy token", async () => {
    const { server } = app();
    const res = await server.inject({ method: "GET", url, headers: { "x-logs-token": PROXY } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-vercel-deployment-id"]).toBe("dpl_9");
    expect(res.body).toBe('{"rowId":"r1","message":"hi"}\n{"rowId":"r2"');
  });

  it("keeps the two tokens apart: neither opens the other's routes", async () => {
    const { server, logProxy } = app();
    expect((await server.inject({ method: "GET", url, headers: { "x-internal-token": INTERNAL } })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/deployments?state=active", headers: { "x-internal-token": PROXY } })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/deployments?state=active", headers: { "x-logs-token": PROXY } })).statusCode).toBe(401);
    expect(logProxy.openRuntime).not.toHaveBeenCalled();
  });

  it("is off (503) when LOGS_PROXY_TOKEN is not set, and maps errors before streaming", async () => {
    const off = app({ logsProxyToken: undefined }).server;
    expect((await off.inject({ method: "GET", url, headers: { "x-logs-token": PROXY } })).statusCode).toBe(503);

    const { server, logProxy } = app();
    logProxy.openRuntime.mockRejectedValueOnce(Object.assign(new (await import("@orbitops/integration-common/provider-error")).ProviderError("Nothing live.", 404, "not_deployed")));
    const res = await server.inject({ method: "GET", url, headers: { "x-logs-token": PROXY } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_deployed", message: "Nothing live." });
  });
});
