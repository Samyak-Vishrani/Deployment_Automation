import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFetch, retryAfterMs } from "../http/provider-fetch";
import { expectOk, renderRequest, setRenderApiBase } from "./render-http";

const KEY = "rnd_secret_api_key_value_123456";

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setRenderApiBase("https://render.test/v1");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const failure = async (status: number, body: unknown) => {
  fetchMock.mockImplementation(async () => reply(status, body));
  const response = await renderRequest({ apiKey: KEY }, "POST", "/services", { body: {}, fetch: { attempts: 1 } });
  try {
    expectOk(response, "creating the Render service", [KEY]);
  } catch (error) {
    return error as { code: string; status: number; message: string; invalidToken: boolean };
  }
  throw new Error("expected a failure");
};

describe("renderRequest", () => {
  it("sends the key as a bearer token, refuses redirects and repeats list query keys", async () => {
    fetchMock.mockResolvedValue(reply(200, []));
    await renderRequest({ apiKey: KEY }, "GET", "/logs", { query: { type: ["build", "app"], limit: 100, cursor: undefined } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://render.test/v1/logs?type=build&type=app&limit=100");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("refuses a path that is not an absolute API path", async () => {
    await expect(renderRequest({ apiKey: KEY }, "GET", "//evil.com/x")).rejects.toThrow(/absolute API paths/);
  });

  it("turns a network failure into render_unavailable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(renderRequest({ apiKey: KEY }, "GET", "/owners", { fetch: { attempts: 1 } })).rejects.toMatchObject({
      code: "render_unavailable",
      retryable: true,
    });
  });
});

describe("renderError", () => {
  it("maps 401 to an invalid key", async () => {
    const error = await failure(401, { message: "unauthorized" });
    expect(error).toMatchObject({ code: "render_key_invalid", status: 412, invalidToken: true });
  });

  it("recognises a repository-access failure and says how to fix it", async () => {
    const error = await failure(400, { message: "could not access repository me/shop" });
    expect(error.code).toBe("render_repo_access");
    expect(error.message).toMatch(/Account Settings → Git/);
  });

  it("maps billing, forbidden, conflict and server errors", async () => {
    expect((await failure(402, { message: "payment info required" })).code).toBe("render_billing");
    expect((await failure(403, { message: "nope" })).code).toBe("render_forbidden");
    expect((await failure(409, { message: "busy" })).code).toBe("render_conflict");
    expect((await failure(500, {})).code).toBe("render_unavailable");
  });

  it("redacts the key if Render ever echoes it back", async () => {
    const error = await failure(400, { message: `bad request for key ${KEY}` });
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain("***REDACTED***");
  });
});

describe("rate limits", () => {
  it("honours Render's relative Ratelimit-Reset header", async () => {
    expect(retryAfterMs(new Headers({ "ratelimit-reset": "7" }))).toBe(7000);
    fetchMock
      .mockResolvedValueOnce(reply(429, {}, { "ratelimit-reset": "2" }))
      .mockResolvedValueOnce(reply(200, { ok: true }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const response = await providerFetch("https://render.test/v1/owners", { method: "GET" }, { sleep });
    expect(response.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
  });
});
