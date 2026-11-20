import type { ProviderResponse } from "@orbitops/integration-common/provider-fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectOk, neonError, neonRequest, setNeonApiBase } from "./neon-http";

const res = (status: number, body: unknown): ProviderResponse<unknown> => ({ status, headers: new Headers(), body });

describe("neonError", () => {
  it("maps a 401 to an invalid key", () => {
    const error = neonError(res(401, { message: "unauthorized" }), "creating the Neon project");
    expect([error.status, error.code, error.invalidToken]).toEqual([412, "neon_key_invalid", true]);
  });

  it("recognises the project limit and a missing organization", () => {
    expect(neonError(res(422, { message: "projects limit exceeded" }), "x").code).toBe("neon_project_limit");
    expect(neonError(res(409, { message: "You have reached the project quota" }), "x").code).toBe("neon_project_limit");
    expect(neonError(res(400, { message: "org_id is required" }), "x").code).toBe("neon_org_required");
  });

  it("maps locked, rate limited and server errors as retryable", () => {
    const locked = neonError(res(423, { message: "project already has running conflicting operations" }), "x");
    expect([locked.code, locked.retryable]).toEqual(["neon_locked", true]);
    expect(neonError(res(429, {}), "x").retryable).toBe(true);
    const server = neonError(res(503, {}), "x");
    expect([server.status, server.code, server.retryable]).toEqual([502, "neon_unavailable", true]);
  });

  it("maps other 403s to forbidden and the rest to a generic error", () => {
    expect(neonError(res(403, { message: "not a member" }), "x").code).toBe("neon_forbidden");
    expect(neonError(res(400, { message: "bad region" }), "x").code).toBe("neon_error");
  });

  it("never lets the key or a connection string into the message", () => {
    const key = "napi_abcdefghijklmnopqrstuvwxyz0123456789";
    const error = neonError(
      res(400, { message: `key ${key} cannot use postgresql://owner:npg_pw@ep-x.neon.tech/neondb` }),
      "x",
      [key],
    );
    expect(error.message).not.toContain(key);
    expect(error.message).not.toContain("npg_pw");
  });

  it("passes 2xx bodies through", () => {
    expect(expectOk(res(200, { ok: 1 }), "x")).toEqual({ ok: 1 });
  });
});

describe("neonRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setNeonApiBase("https://console.neon.tech/api/v2");
  });

  it("sends the bearer key, refuses redirects and builds the query", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ uri: "x" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setNeonApiBase("https://neon.test/api/v2/");
    await neonRequest({ apiKey: "napi_key" }, "GET", "/projects/p1/connection_uri", { query: { pooled: true, x: null } });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://neon.test/api/v2/projects/p1/connection_uri?pooled=true");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer napi_key");
    expect(init.redirect).toBe("error");
  });

  it("turns a network failure into neon_unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("ECONNREFUSED"))));
    await expect(
      neonRequest({ apiKey: "k" }, "POST", "/projects", { body: {}, fetch: { sleep: async () => undefined } }),
    ).rejects.toMatchObject({ code: "neon_unavailable" });
  });

  it("refuses relative paths", async () => {
    await expect(neonRequest({ apiKey: "k" }, "GET", "projects")).rejects.toThrow(/absolute/);
  });
});
