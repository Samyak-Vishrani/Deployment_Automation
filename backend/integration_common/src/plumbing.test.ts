import { afterEach, describe, expect, it, vi } from "vitest";
import { baseUrl, MissingEnvError, positiveInt, requireEnv, requireSecretLength } from "./config-helpers";
import { isTerminal } from "./contract";
import { isValidInternalToken } from "./internal-auth";
import { badRequest, conflict, notFound, ProviderError } from "./provider-error";
import { NetworkError, providerFetch, retryAfterMs } from "./provider-fetch";
import { redact } from "./redact";

describe("isValidInternalToken", () => {
  it("accepts only the exact token", () => {
    expect(isValidInternalToken("a".repeat(32), "a".repeat(32))).toBe(true);
    expect(isValidInternalToken("a".repeat(32), "a".repeat(31))).toBe(false);
    expect(isValidInternalToken("a".repeat(32), undefined)).toBe(false);
    expect(isValidInternalToken("a".repeat(32), "")).toBe(false);
    expect(isValidInternalToken("a".repeat(32), ["a".repeat(32)])).toBe(false);
  });
});

describe("redact", () => {
  it("masks known literals and token shapes", () => {
    const out = redact(
      "key=supersecretvalue gh=ghs_abcdefghijklmnopqrstuvwxyz auth=Bearer abcdefghijklmnopqrstuvwxyz0123",
      ["supersecretvalue"],
    );
    expect(out).not.toContain("supersecretvalue");
    expect(out).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  it("leaves short literals alone, so ordinary output is not mangled", () => {
    expect(redact("the value is abc", ["abc"])).toBe("the value is abc");
  });

  it("masks a Postgres connection string's password when it is passed as a literal", () => {
    const uri = "postgresql://owner:npg_s3cretPassw0rd@ep-x.us-west-2.aws.neon.tech/neondb";
    expect(redact(`DATABASE_URL=${uri}`, [uri])).toBe("DATABASE_URL=***REDACTED***");
  });
});

describe("retryAfterMs", () => {
  it("reads all three rate-limit headers", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "3" }))).toBe(3000);
    expect(retryAfterMs(new Headers({ "ratelimit-reset": "7" }))).toBe(7000);
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset": "105" }), 100_000)).toBe(5000);
    expect(retryAfterMs(new Headers())).toBeNull();
  });
});

describe("providerFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries a 429 then returns the parsed body", async () => {
    const responses = [
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const sleeps: number[] = [];
    const result = await providerFetch<{ ok: boolean }>("https://api.test/x", { method: "GET" }, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(sleeps).toEqual([0]);
  });

  it("does not retry a POST after a network error, by default", async () => {
    const fetchMock = vi.fn(async () => Promise.reject(new TypeError("ECONNRESET")));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      providerFetch("https://api.test/x", { method: "POST" }, { sleep: async () => undefined }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("errors", () => {
  it("carries status, code and flags", () => {
    const error = new ProviderError("no", 412, "x_key_invalid", { invalidToken: true, retryable: false });
    expect([error.status, error.code, error.invalidToken, error.retryable]).toEqual([412, "x_key_invalid", true, false]);
    expect(badRequest("b").status).toBe(400);
    expect(notFound("n").status).toBe(404);
    expect(conflict("c").status).toBe(409);
  });
});

describe("config helpers", () => {
  it("lists every missing variable, and ENCRYPTION_KEY only in production", () => {
    expect(() => requireEnv({ A: "1" }, ["A", "B", "C"], "neondb_integration")).toThrow(/B, C.*neondb_integration/);
    expect(() => requireEnv({ A: "1", NODE_ENV: "production" }, ["A"], "x")).toThrow(MissingEnvError);
    expect(() => requireEnv({ A: "1" }, ["A"], "x")).not.toThrow();
  });

  it("checks secret length", () => {
    expect(() => requireSecretLength({ T: "short" }, ["T"])).toThrow(/at least 32/);
    expect(() => requireSecretLength({ T: "x".repeat(32) }, ["T"])).not.toThrow();
  });

  it("parses numbers and URLs", () => {
    expect(positiveInt("12", 3)).toBe(12);
    expect(positiveInt("-1", 3)).toBe(3);
    expect(positiveInt(undefined, 3)).toBe(3);
    expect(baseUrl("http://x/// ", "d")).toBe("http://x");
    expect(baseUrl("", "http://d/")).toBe("http://d");
  });

  it("knows terminal states", () => {
    expect(isTerminal("live")).toBe(true);
    expect(isTerminal("building")).toBe(false);
  });
});
