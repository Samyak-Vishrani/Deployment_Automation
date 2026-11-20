import { describe, expect, it } from "vitest";
import { consoleUrl, isPostgresUri, safeHost, systemEnv } from "./connection";
import { allFinished, describeFailure, firstFailure } from "./operations";
import { neonProjectName } from "./project-name";
import { DEFAULT_REGION, isPgVersion, isRegionId } from "./regions";

describe("neonProjectName", () => {
  it("joins project and component as a lowercase slug", () => {
    expect(neonProjectName("Vercel_Integration_test", "database")).toBe("vercel-integration-test-database");
  });

  it("does not repeat the project name", () => {
    expect(neonProjectName("shop", "shop-db")).toBe("shop-db");
  });

  it("caps the length at 64, keeping the suffix", () => {
    const name = neonProjectName("a".repeat(80), "database", "ab12");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith("-ab12")).toBe(true);
  });

  it("adds a random suffix on request, and never returns an empty name", () => {
    expect(neonProjectName("shop", "db", true)).toMatch(/^shop-db-[0-9a-f]{4}$/);
    expect(neonProjectName("___", "!!!")).toBe("orbitops-database");
  });
});

describe("regions", () => {
  it("defaults to Oregon and validates ids and versions", () => {
    expect(DEFAULT_REGION).toBe("aws-us-west-2");
    expect(isRegionId("aws-eu-central-1")).toBe(true);
    expect(isRegionId("oregon")).toBe(false);
    expect(isPgVersion(17)).toBe(true);
    expect(isPgVersion(14)).toBe(false);
  });
});

describe("connection helpers", () => {
  const pooled = "postgresql://owner:npg_secret@ep-a-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require";
  const direct = "postgresql://owner:npg_secret@ep-a.us-west-2.aws.neon.tech/neondb?sslmode=require";

  it("names the two system env vars", () => {
    expect(systemEnv({ pooledUri: pooled, directUri: direct })).toEqual([
      { key: "DATABASE_URL", value: pooled },
      { key: "DATABASE_URL_UNPOOLED", value: direct },
    ]);
  });

  it("shows only the host, never the password", () => {
    expect(safeHost(direct)).toBe("ep-a.us-west-2.aws.neon.tech");
    expect(safeHost("https://x.test")).toBeNull();
    expect(safeHost("not a uri")).toBeNull();
    expect(safeHost(null)).toBeNull();
  });

  it("accepts only Postgres URIs with a user and host", () => {
    expect(isPostgresUri(pooled)).toBe(true);
    expect(isPostgresUri("postgres://u@h/db")).toBe(true);
    expect(isPostgresUri("https://u@h/db")).toBe(false);
    expect(isPostgresUri("postgresql:///db")).toBe(false);
    expect(isPostgresUri(42)).toBe(false);
  });

  it("links to the project on the console", () => {
    expect(consoleUrl("young-sun-123")).toBe("https://console.neon.tech/app/projects/young-sun-123");
  });
});

describe("operations", () => {
  it("is finished only when nothing is scheduled or running", () => {
    expect(allFinished([{ status: "finished" }, { status: "skipped" }])).toBe(true);
    expect(allFinished([{ status: "finished" }, { status: "running" }])).toBe(false);
    expect(allFinished([{ status: "scheduling" }])).toBe(false);
    expect(allFinished([])).toBe(true);
  });

  it("finds and describes a failure", () => {
    const failed = firstFailure([{ status: "finished" }, { status: "failed", action: "start_compute", error: "no capacity" }]);
    expect(failed?.action).toBe("start_compute");
    expect(describeFailure(failed!)).toBe("start compute failed: no capacity");
    expect(firstFailure([{ status: "finished" }])).toBeUndefined();
  });
});
