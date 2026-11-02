import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/prisma", () => ({ default: { $queryRaw: vi.fn() } }));
import prisma from "@/lib/db/prisma";
import { parseEnvironment, readBody, requireTrustedOrigin, rateLimit, scrubLogs } from "./security";
afterEach(() => vi.unstubAllEnvs());
describe("Render security", () => {
  it("requires the exact configured origin, even for a same-site sibling", () => {
    vi.stubEnv("FRONTEND_URL", "https://app.example.com");
    expect(() => requireTrustedOrigin(new Request("https://api.example.com", { headers: { Origin: "https://evil.example.com" } }))).toThrow();
    expect(() => requireTrustedOrigin(new Request("https://api.example.com"))).toThrow();
    expect(() => requireTrustedOrigin(new Request("https://api.example.com", { headers: { Origin: "https://app.example.com" } }))).not.toThrow();
  });
  it("rejects malformed, oversized and non-JSON bodies", async () => {
    await expect(readBody(new Request("http://local", { method: "POST", body: "{}" }))).rejects.toMatchObject({ status: 400 });
    await expect(readBody(new Request("http://local", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(70_000) }))).rejects.toMatchObject({ status: 413 });
    await expect(readBody(new Request("http://local", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" }))).rejects.toMatchObject({ status: 400 });
  });
  it("rejects unsafe env keys, nonstrings, and NULs", () => {
    for (const value of [JSON.parse('{"__proto__":"x"}'), { X: 7 }, { X: "a\0b" }, { "BAD-KEY": "x" }]) expect(() => parseEnvironment(value)).toThrow();
    expect(parseEnvironment({ DATABASE_URL: "postgres://user:secret@host/db" })).toEqual({ DATABASE_URL: "postgres://user:secret@host/db" });
  });
  it("redacts exact short secrets, Render keys, Groq keys and database passwords", () => {
    const safe = scrubLogs("password=supersecret rnd_12345 gsk_12345 PIN 123 postgres://user:password@host/db", ["123"]);
    expect(safe).not.toContain("supersecret"); expect(safe).not.toContain("rnd_"); expect(safe).not.toContain("gsk_"); expect(safe).not.toContain("123"); expect(safe).not.toContain(":password@");
  });
  it("caps log output", () => expect(scrubLogs("a".repeat(90_000), [])).toHaveLength(60_000));
  it("enforces the shared database rate limit", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 7 }]);
    await expect(rateLimit("u1", "deploy", 6)).rejects.toMatchObject({ status: 429 });
  });
});
