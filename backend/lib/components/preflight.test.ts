import { describe, expect, it, vi } from "vitest";
import {
  envExampleKeys,
  runPreflight,
  type PreflightComponent,
  type PreflightDeps,
  type PreflightResult,
} from "@/lib/components/preflight";

const web: PreflightComponent = { id: "c1", kind: "frontend", name: "web", rootDir: "frontend", provider: "vercel" };
const api: PreflightComponent = { id: "c2", kind: "backend", name: "api", rootDir: "backend", provider: "render" };
const db: PreflightComponent = { id: "c3", kind: "database", name: "database", rootDir: ".", provider: "neon" };

function deps(overrides: Partial<PreflightDeps> = {}, files: Record<string, string> = {}): PreflightDeps {
  return {
    listTree: vi.fn(async () => ({
      entries: [
        { path: "frontend", type: "tree" },
        { path: "backend", type: "tree" },
        ...Object.keys(files).map((path) => ({ path, type: "blob" })),
      ],
      truncated: false,
    })),
    readFile: vi.fn(async (path: string) => files[path]),
    hasCredential: vi.fn(async () => false),
    ...overrides,
  };
}

const project = { userId: "u1", filledEnvKeys: [] as string[] };
const byId = (result: PreflightResult, id: string) =>
  result.checks.find((check) => check.id === id);

describe("runPreflight", () => {
  it("fails when nothing is configured, without touching GitHub", async () => {
    const d = deps();
    const result = await runPreflight(project, [], d);
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([expect.objectContaining({ id: "components", status: "fail" })]);
    expect(d.listTree).not.toHaveBeenCalled();
  });

  it("passes existing folders and leaves credentials pending until Phase 6", async () => {
    const result = await runPreflight(project, [web, api], deps());
    expect(byId(result, "root-dir:c1")?.status).toBe("pass");
    expect(byId(result, "root-dir:c2")?.status).toBe("pass");
    expect(byId(result, "credential:vercel")).toMatchObject({
      status: "pending",
      message: "Vercel deployment is not available yet.",
    });
    expect(result.ok).toBe(false);
  });

  it("is ok once every check passes", async () => {
    const result = await runPreflight(project, [web], deps({ hasCredential: async () => true }));
    expect(result.ok).toBe(true);
  });

  it("fails a folder that is not in the tree", async () => {
    const result = await runPreflight(project, [{ ...web, rootDir: "apps/web" }], deps());
    expect(byId(result, "root-dir:c1")).toMatchObject({ status: "fail" });
    expect(byId(result, "root-dir:c1")?.message).toContain('"apps/web" does not exist');
  });

  it("does not fail a missing folder in a truncated tree", async () => {
    const result = await runPreflight(
      project,
      [{ ...web, rootDir: "apps/web" }],
      deps({ listTree: async () => ({ entries: [], truncated: true }) }),
    );
    expect(byId(result, "root-dir:c1")?.status).toBe("pending");
  });

  it("names the env vars without a value, never their values", async () => {
    const files = { "backend/.env.example": "# comment\nPORT=3000\nexport API_KEY=\nSECRET=changeme\n" };
    const result = await runPreflight({ ...project, filledEnvKeys: ["PORT"] }, [api], deps({}, files));
    const env = byId(result, "env:c2");
    expect(env?.status).toBe("fail");
    expect(env?.message).toContain("API_KEY, SECRET");
    expect(env?.message).not.toContain("changeme");
  });

  it("counts DATABASE_URL as provided when a database is configured", async () => {
    const files = { "backend/.env.example": "DATABASE_URL=postgres://localhost/db\n" };
    const without = await runPreflight(project, [api], deps({}, files));
    const withDb = await runPreflight(project, [api, db], deps({}, files));
    expect(byId(without, "env:c2")?.status).toBe("fail");
    expect(byId(withDb, "env:c2")?.status).toBe("pass");
  });

  it("passes the env check when there is no .env.example, without reading files", async () => {
    const d = deps();
    const result = await runPreflight(project, [web], d);
    expect(byId(result, "env:c1")?.status).toBe("pass");
    expect(d.readFile).not.toHaveBeenCalled();
  });

  it("reports an unreadable repository on each folder check", async () => {
    const result = await runPreflight(
      project,
      [web],
      deps({ listTree: async () => Promise.reject(new Error("Could not read the repository from GitHub (HTTP 502).")) }),
    );
    expect(byId(result, "root-dir:c1")).toMatchObject({
      status: "fail",
      message: "web: Could not read the repository from GitHub (HTTP 502).",
    });
    expect(byId(result, "env:c1")?.status).toBe("pending");
  });

  it("checks each provider once", async () => {
    const result = await runPreflight(project, [web, { ...web, id: "c9", rootDir: "backend" }], deps());
    expect(result.checks.filter((check) => check.id === "credential:vercel")).toHaveLength(1);
  });
});

describe("envExampleKeys", () => {
  it("reads KEY= and export KEY= lines and skips comments", () => {
    expect(envExampleKeys("A=1\r\n# B=2\n  export C=\nnot a var\nD = x")).toEqual(["A", "C", "D"]);
  });
});
