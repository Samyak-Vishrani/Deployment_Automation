import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { open, seal, SecretBoxError } from "@/lib/crypto/secret-box";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Flips one character of a base64url part without changing its length. */
function tamper(sealed: string, index: number): string {
  const parts = sealed.split(".");
  const part = parts[index];
  parts[index] = (part[0] === "A" ? "B" : "A") + part.slice(1);
  return parts.join(".");
}

describe("secret box", () => {
  it("round-trips a value", () => {
    const sealed = seal("gho_usertoken");

    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("gho_usertoken");
    expect(open(sealed)).toBe("gho_usertoken");
  });

  it("uses a fresh IV each time", () => {
    expect(seal("same")).not.toBe(seal("same"));
  });

  it("round-trips with a configured key", () => {
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));

    expect(open(seal("ghr_refresh"))).toBe("ghr_refresh");
  });

  it("refuses a value sealed with a different key", () => {
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    const sealed = seal("secret");
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));

    expect(() => open(sealed)).toThrow(SecretBoxError);
  });

  it.each([
    ["ciphertext", 3],
    ["tag", 2],
    ["iv", 1],
  ])("throws when the %s was tampered with", (_part, index) => {
    expect(() => open(tamper(seal("secret"), index))).toThrow(SecretBoxError);
  });

  it("throws on an unknown version", () => {
    const sealed = seal("secret").replace(/^v1\./, "v9.");

    expect(() => open(sealed)).toThrow(/unknown key version "v9"/);
  });

  it("throws on a malformed value", () => {
    expect(() => open("not-sealed")).toThrow(SecretBoxError);
  });

  it("requires ENCRYPTION_KEY in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENCRYPTION_KEY", "");

    expect(() => seal("secret")).toThrow(/ENCRYPTION_KEY must be set in production/);
  });

  it("rejects a key of the wrong length", () => {
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(16).toString("base64"));

    expect(() => seal("secret")).toThrow(/32 bytes/);
  });
});
