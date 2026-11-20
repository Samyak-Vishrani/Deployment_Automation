import { describe, expect, it } from "vitest";
import { publicEnvHash, staleKeys } from "../vercel/public-env";
import { parseDeployRequest, parsePublicEnvVars } from "./deploy-input";

const body = {
  deploymentId: "dep1",
  userId: "u1",
  component: { id: "comp1", name: "web", rootDir: "frontend", framework: "nextjs" },
  repo: { fullName: "me/shop", repoId: 42, branch: "main" },
  commitSha: "a".repeat(40),
};

describe("publicEnvVars in the deploy request", () => {
  it("is optional, and kept when sent (even empty)", () => {
    expect(parseDeployRequest(body)).not.toHaveProperty("publicEnvVars");
    expect(parseDeployRequest({ ...body, publicEnvVars: [] }).publicEnvVars).toEqual([]);
    expect(
      parseDeployRequest({ ...body, publicEnvVars: [{ key: "NEXT_PUBLIC_API_URL", value: "https://api.onrender.com" }] })
        .publicEnvVars,
    ).toEqual([{ key: "NEXT_PUBLIC_API_URL", value: "https://api.onrender.com" }]);
  });

  it("refuses anything that looks like a secret, lower-case keys, duplicates and multi-line values", () => {
    expect(() => parsePublicEnvVars([{ key: "NEXT_PUBLIC_API_KEY", value: "x" }])).toThrow(/looks like a secret/);
    expect(() => parsePublicEnvVars([{ key: "DB_PASSWORD", value: "x" }])).toThrow(/looks like a secret/);
    expect(() => parsePublicEnvVars([{ key: "api_url", value: "x" }])).toThrow(/upper-case/);
    expect(() =>
      parsePublicEnvVars([
        { key: "API_URL", value: "a" },
        { key: "API_URL", value: "b" },
      ]),
    ).toThrow(/twice/);
    expect(() => parsePublicEnvVars([{ key: "API_URL", value: "a\nb" }])).toThrow(/single-line/);
    expect(() => parsePublicEnvVars("nope")).toThrow(/array/);
  });
});

describe("public env helpers", () => {
  it("hashes independently of order, and sees value changes", () => {
    const a = [
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ];
    expect(publicEnvHash(a)).toBe(publicEnvHash([...a].reverse()));
    expect(publicEnvHash(a)).not.toBe(publicEnvHash([{ key: "A", value: "1" }, { key: "B", value: "3" }]));
  });

  it("lists only previously managed keys that are no longer sent", () => {
    expect(staleKeys(["A", "B"], [{ key: "A", value: "1" }])).toEqual(["B"]);
    expect(staleKeys("not an array", [])).toEqual([]);
  });
});

describe("envVars in the deploy request (Phase 9)", () => {
  const vars = [
    { key: "NEXT_PUBLIC_GREETING", value: "hello", secret: false },
    { key: "SERVER_TOKEN", value: "multi\nline", secret: true },
  ];

  it("is optional and keeps the secret flag; multi-line values are fine", () => {
    expect(parseDeployRequest(body)).not.toHaveProperty("envVars");
    expect(parseDeployRequest({ ...body, envVars: vars }).envVars).toEqual(vars);
  });

  it("refuses reserved, duplicate and clashing keys without echoing values", () => {
    const bad = (envVars: unknown, extra: object = {}) => () => parseDeployRequest({ ...body, ...extra, envVars });
    expect(bad([{ key: "VERCEL_URL", value: "x", secret: false }])).toThrow(/reserved by Vercel/);
    expect(bad([{ key: "TZ", value: "x", secret: false }])).toThrow(/reserved by Vercel/);
    expect(bad([vars[0], vars[0]])).toThrow(/twice/);
    expect(bad([{ key: "A", value: "x" }])).toThrow(/secret must be true or false/);
    expect(bad([{ key: "1A", value: "x", secret: false }])).toThrow(/variable name/);
    expect(
      bad([{ key: "NEXT_PUBLIC_API_URL", value: "x", secret: false }], {
        publicEnvVars: [{ key: "NEXT_PUBLIC_API_URL", value: "https://api.onrender.com" }],
      }),
    ).toThrow(/both set NEXT_PUBLIC_API_URL/);
    try {
      parseDeployRequest({ ...body, envVars: [{ key: "BIG", value: "s3cret".repeat(10_000), secret: true }] });
    } catch (error) {
      expect((error as Error).message).toMatch(/BIG/);
      expect((error as Error).message).not.toContain("s3cret");
    }
  });
});
