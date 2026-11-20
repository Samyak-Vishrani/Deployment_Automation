import { describe, expect, it } from "vitest";
import { parseDotenv } from "./env-file";
import { parseEnvPut } from "./env-input";
import { envProblem, isPublicKey, looksSecret, MAX_VALUE_BYTES, reservedReason } from "./env-rules";
import { systemEnvKeys } from "./system-env";

describe("env-rules", () => {
  it("guesses secrets from the key, but never for a public prefix", () => {
    expect(looksSecret("STRIPE_SECRET_KEY")).toBe(true);
    expect(looksSecret("DATABASE_URL")).toBe(true);
    expect(looksSecret("SENTRY_DSN")).toBe(true);
    expect(looksSecret("GREETING")).toBe(false);
    expect(looksSecret("NEXT_PUBLIC_STRIPE_KEY")).toBe(false);
    expect(isPublicKey("vite_api_url")).toBe(true);
  });

  it("refuses the keys each provider sets itself", () => {
    expect(reservedReason("VERCEL_URL", "vercel")).toMatch(/system variables/);
    expect(reservedReason("TZ", "vercel")).toMatch(/reserved/);
    expect(reservedReason("RENDER_SERVICE_ID", "render")).toMatch(/Render/);
    expect(reservedReason("RENDER", "render")).toMatch(/Render/);
    expect(reservedReason("NODE_ENV", "render")).toBeNull();
    expect(reservedReason("RENDER_X", "vercel")).toBeNull();
  });

  it("validates a scope's set and names the key, never the value", () => {
    const frontend = { kind: "frontend", provider: "vercel", name: "web" } as const;
    expect(envProblem([{ key: "1BAD", isSecret: false, value: "x" }], frontend)).toMatch(/not a valid variable name/);
    expect(envProblem([{ key: "A", isSecret: false }, { key: "A", isSecret: false }], frontend)).toMatch(/set twice/);
    expect(envProblem([{ key: "NEXT_PUBLIC_X", isSecret: true, value: "hunter2" }], frontend)).toMatch(/cannot be a secret/);
    const big = envProblem([{ key: "PEM", isSecret: true, value: "x".repeat(MAX_VALUE_BYTES + 1) }], frontend);
    expect(big).toMatch(/PEM is 33 KB/);
    expect(envProblem([{ key: "RENDER_X", isSecret: false, value: "v" }], { kind: "shared" })).toMatch(/set by Render/);
    expect(envProblem([{ key: "A", isSecret: false, value: "v" }], { kind: "database", provider: "neon", name: "db" })).toMatch(/database/);
    // A NEXT_PUBLIC_ secret is fine on a backend: nothing inlines it there.
    expect(envProblem([{ key: "NEXT_PUBLIC_X", isSecret: true, value: "v" }], { kind: "backend", provider: "render", name: "api" })).toBeNull();
    const total = Array.from({ length: 8 }, (_, i) => ({ key: `K${i}`, isSecret: true, value: "x".repeat(8 * 1024) }));
    expect(envProblem(total, frontend)).toMatch(/64 KB per deployment/);
    expect(envProblem(total, { kind: "backend", provider: "render", name: "api" })).toBeNull();
  });
});

describe("parseDotenv", () => {
  it("reads plain, exported, quoted and commented lines", () => {
    const { entries, skipped } = parseDotenv(
      [
        "# a comment",
        "PLAIN=hello world # trailing",
        "export EXPORTED=yes",
        'DOUBLE="line1\\nline2 \\"q\\""',
        "SINGLE='literal \\n #kept'",
        'MULTI="-----BEGIN',
        'body',
        '-----END"',
        "EMPTY=",
        "HASH=a#b",
        "not a line",
        "1BAD=x",
        "PLAIN=again",
      ].join("\r\n"),
    );
    expect(Object.fromEntries(entries.map((e) => [e.key, e.value]))).toEqual({
      PLAIN: "again",
      EXPORTED: "yes",
      DOUBLE: 'line1\nline2 "q"',
      SINGLE: "literal \\n #kept",
      MULTI: "-----BEGIN\nbody\n-----END",
      EMPTY: "",
      HASH: "a#b",
    });
    expect(skipped).toEqual([
      { line: 11, reason: "no KEY=value" },
      { line: 12, reason: '"1BAD" is not a valid name' },
    ]);
  });

  it("reports an unclosed quote", () => {
    expect(parseDotenv('A="never closed').skipped).toEqual([{ line: 1, reason: "A: the \" quote is never closed" }]);
  });
});

describe("parseEnvPut", () => {
  it("accepts rows, defaulting to secret and keeping omitted values", () => {
    expect(parseEnvPut({ vars: [{ key: " A ", value: "1" }, { key: "B", isSecret: false }] })).toEqual({
      vars: [
        { key: "A", value: "1", isSecret: true },
        { key: "B", isSecret: false },
      ],
    });
  });

  it("refuses bad bodies without echoing values", () => {
    expect(() => parseEnvPut(null)).toThrow(/JSON object/);
    expect(() => parseEnvPut({ vars: {} })).toThrow(/array/);
    expect(() => parseEnvPut({ vars: [{ key: "A", value: 5 }] })).toThrow(/A: value must be a string/);
    expect(() => parseEnvPut({ vars: [{ key: "A" }, { key: "A" }] })).toThrow(/set twice/);
    expect(() => parseEnvPut({ vars: Array.from({ length: 101 }, (_, i) => ({ key: `K${i}` })) })).toThrow(/At most 100/);
  });
});

describe("systemEnvKeys", () => {
  const web = { id: "w", kind: "frontend", provider: "vercel", framework: "nextjs", buildCmd: null, name: "web" } as const;
  const api = { id: "a", kind: "backend", provider: "render", framework: "express", buildCmd: null, name: "api" } as const;
  const db = { id: "d", kind: "database", provider: "neon", framework: "postgres", buildCmd: null, name: "db" } as const;

  it("gives a Render backend the Neon keys and a Vercel frontend the API URL", () => {
    expect(systemEnvKeys(api, [web, api, db]).map((k) => k.key)).toEqual(["DATABASE_URL", "DATABASE_URL_UNPOOLED"]);
    expect(systemEnvKeys(api, [web, api])).toEqual([]);
    expect(systemEnvKeys(web, [web, api, db])).toEqual([{ key: "NEXT_PUBLIC_API_URL", source: "backend", from: "api", userWins: true }]);
    expect(systemEnvKeys(web, [web, api, { ...api, id: "a2", name: "api2" }])).toEqual([]);
  });
});
