import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFetch, retryAfterMs } from "../http/provider-fetch";
import { ProviderError } from "../http/provider-error";
import { expectOk, setVercelApiBase, vercelRequest } from "./vercel-http";

const TOKEN = "vercel_secret_token_value_123";

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setVercelApiBase("https://vercel.test");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vercelRequest", () => {
  it("sends the bearer token and appends teamId", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    await vercelRequest({ token: TOKEN, teamId: "team_1" }, "GET", "/v2/user", { query: { limit: 5, skip: undefined } });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://vercel.test/v2/user?limit=5&teamId=team_1");
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it("maps a 401 to vercel_token_invalid without leaking the token", async () => {
    fetchMock.mockResolvedValue(reply(401, { error: { code: "unauthorized", message: "bad" } }));
    const response = await vercelRequest({ token: TOKEN, teamId: null }, "GET", "/v2/user");

    let caught: unknown;
    try {
      expectOk(response, "checking the token");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe("vercel_token_invalid");
    expect((caught as ProviderError).invalidToken).toBe(true);
    expect((caught as ProviderError).message).not.toContain(TOKEN);
  });

  it("treats a 403 with invalidToken as a bad token, and other 403s as forbidden", async () => {
    fetchMock.mockResolvedValueOnce(reply(403, { error: { code: "forbidden", invalidToken: true } }));
    fetchMock.mockResolvedValueOnce(reply(403, { error: { code: "forbidden", message: "Not a team member" } }));
    const ctx = { token: TOKEN, teamId: "t" };

    const a = await vercelRequest(ctx, "GET", "/a");
    const b = await vercelRequest(ctx, "GET", "/b");
    expect(() => expectOk(a, "x")).toThrow(expect.objectContaining({ code: "vercel_token_invalid" }));
    expect(() => expectOk(b, "x")).toThrow(expect.objectContaining({ code: "vercel_forbidden" }));
  });

  it("turns a network failure into vercel_unavailable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      vercelRequest({ token: TOKEN, teamId: null }, "POST", "/v11/projects", { body: {}, fetch: { attempts: 1 } }),
    ).rejects.toMatchObject({ code: "vercel_unavailable", retryable: true });
  });
});

describe("providerFetch", () => {
  it("retries a 429 after the time the provider asked for", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(429, {}, { "retry-after": "2" }))
      .mockResolvedValueOnce(reply(200, { done: true }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const response = await providerFetch("https://vercel.test/x", { method: "GET" }, { sleep });
    expect(response.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
  });

  it("returns the last response once retries are used up", async () => {
    fetchMock.mockImplementation(async () => reply(503, { error: {} }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const response = await providerFetch("https://vercel.test/x", { method: "GET" }, { sleep, attempts: 3 });
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a POST on a network error (it may have landed)", async () => {
    fetchMock.mockRejectedValue(new TypeError("socket hang up"));
    await expect(providerFetch("https://vercel.test/x", { method: "POST" }, { sleep: vi.fn() })).rejects.toThrow(
      "socket hang up",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads retry-after and x-ratelimit-reset", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "3" }))).toBe(3000);
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset": "110" }), 100_000)).toBe(10_000);
    expect(retryAfterMs(new Headers())).toBeNull();
  });
});
