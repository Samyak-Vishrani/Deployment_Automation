import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVICE_UNAVAILABLE, VercelServiceClient } from "./vercel-service.client";

const config = () => ({ baseUrl: "http://svc.test", token: "internal_token" });

afterEach(() => vi.unstubAllGlobals());

describe("VercelServiceClient", () => {
  it("sends the internal token and the user's id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: "connected" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new VercelServiceClient(config).getCredential("user1")).resolves.toEqual({ state: "connected" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://svc.test/users/user1/credential");
    expect((init.headers as Record<string, string>)["x-internal-token"]).toBe("internal_token");
  });

  it("passes the service's error through unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "vercel_token_invalid", message: "Reconnect Vercel." }), { status: 412 }),
      ),
    );
    await expect(new VercelServiceClient(config).saveCredential("u", "t")).rejects.toMatchObject({
      status: 412,
      code: "vercel_token_invalid",
      message: "Reconnect Vercel.",
    });
  });

  it("says the service is not running when it cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(new VercelServiceClient(config).getCredential("u")).rejects.toMatchObject({
      status: 503,
      code: SERVICE_UNAVAILABLE,
    });
  });

  it("explains a token mismatch between the two services", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(new VercelServiceClient(config).getCredential("u")).rejects.toThrow(/INTERNAL_SERVICE_TOKEN/);
  });

  it("refuses to call without a configured token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new VercelServiceClient(() => ({ baseUrl: "http://svc.test", token: "" })).getCredential("u"),
    ).rejects.toThrow(/INTERNAL_SERVICE_TOKEN is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
