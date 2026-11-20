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
    credentialState: vi.fn(async () => "missing" as const),
    ...overrides,
  };
}

const noEnv = () => ({ keys: [] as string[], filled: new Set<string>() });
const project = { userId: "u1", envFor: noEnv };
const withEnv = (...keys: string[]) => ({ userId: "u1", envFor: () => ({ keys, filled: new Set(keys) }) });
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

  it("passes existing folders and asks for a Vercel account when none is connected", async () => {
    const result = await runPreflight(project, [web, api], deps());
    expect(byId(result, "root-dir:c1")?.status).toBe("pass");
    expect(byId(result, "root-dir:c2")?.status).toBe("pass");
    expect(byId(result, "credential:vercel")).toMatchObject({
      status: "fail",
      message: "Connect Vercel in Settings to deploy there.",
    });
    expect(byId(result, "credential:render")).toMatchObject({
      status: "fail",
      message: "Connect Render in Settings to deploy there.",
    });
    expect(result.ok).toBe(false);
    expect(result.deployable).toEqual({ c1: false, c2: false });
  });

  it("is ok once every check passes", async () => {
    const result = await runPreflight(project, [web], deps({ credentialState: async () => "connected" }));
    expect(result.ok).toBe(true);
    expect(result.deployable).toEqual({ c1: true });
  });

  it("keeps a Render backend undeployable until Render can tell how to run it; a Neon database is deployable", async () => {
    const result = await runPreflight(project, [web, api, db], deps({ credentialState: async () => "connected" }));
    expect(result.ok).toBe(false);
    expect(result.deployable).toEqual({ c1: true, c2: false, c3: true });
    expect(byId(result, "runtime:c2")?.status).toBe("fail");
    expect(byId(result, "credential:neon")).toMatchObject({ status: "pass", message: "Neon account connected." });
  });

  it("checks a Neon database: Postgres only, with the migrations advice", async () => {
    const ready = { ...api, framework: "express", startCmd: "npm start" };
    const ok = await runPreflight(project, [web, ready, { ...db, framework: "postgres" }], deps({ credentialState: async () => "connected" }));
    expect(ok.ok).toBe(true);
    expect(byId(ok, "engine:c3")).toMatchObject({ status: "pass" });
    expect(byId(ok, "migrations:c3")).toMatchObject({ status: "pass" });
    expect(byId(ok, "migrations:c3")?.message).toMatch(/DATABASE_URL_UNPOOLED.*migrate deploy/);
    // No root-dir or env checks for a database: it has no folder.
    expect(byId(ok, "root-dir:c3")).toBeUndefined();

    const mysql = await runPreflight(project, [{ ...db, framework: "mysql" }], deps({ credentialState: async () => "connected" }));
    expect(byId(mysql, "engine:c3")).toMatchObject({ status: "fail" });
    expect(byId(mysql, "engine:c3")?.message).toMatch(/Postgres only/);
    expect(mysql.deployable).toEqual({ c3: false });
  });

  it("asks for a Neon account, and names the API key when Neon rejects it", async () => {
    const missing = await runPreflight(project, [db], deps());
    expect(byId(missing, "credential:neon")).toMatchObject({ status: "fail", message: "Connect Neon in Settings to deploy there." });
    expect(missing.deployable).toEqual({ c3: false });

    const invalid = await runPreflight(project, [db], deps({ credentialState: async () => "invalid" }));
    expect(byId(invalid, "credential:neon")?.message).toBe("Neon rejected the saved API key. Reconnect Neon in Settings.");

    const down = await runPreflight(project, [db], deps({ credentialState: async () => "unavailable" }));
    expect(byId(down, "credential:neon")?.message).toMatch(/Neon integration service is not running/);
  });

  it("makes a Render backend deployable once its framework and start command are set", async () => {
    const ready = { ...api, framework: "express", startCmd: "npm start" };
    const result = await runPreflight(project, [web, ready], deps({ credentialState: async () => "connected" }));
    expect(result.deployable).toEqual({ c1: true, c2: true });
    expect(result.ok).toBe(true);
    expect(byId(result, "credential:render")?.message).toMatch(/connected to GitHub/);
  });

  it("asks a Render backend for a start command, except a Docker one", async () => {
    const noStart = await runPreflight(
      project,
      [{ ...api, framework: "nestjs", startCmd: "  " }],
      deps({ credentialState: async () => "connected" }),
    );
    expect(byId(noStart, "start-cmd:c2")).toMatchObject({ status: "fail" });
    expect(byId(noStart, "start-cmd:c2")?.message).toMatch(/add a start command/);

    const docker = await runPreflight(
      project,
      [{ ...api, framework: "docker", startCmd: null }],
      deps({ credentialState: async () => "connected" }),
    );
    expect(byId(docker, "start-cmd:c2")).toBeUndefined();
    expect(docker.deployable).toEqual({ c2: true });
  });

  it("blocks a component whose own checks fail", async () => {
    const result = await runPreflight(
      project,
      [{ ...web, rootDir: "apps/web" }],
      deps({ credentialState: async () => "connected" }),
    );
    expect(result.deployable).toEqual({ c1: false });
  });

  it.each([
    ["invalid", "Vercel rejected the saved token. Reconnect Vercel in Settings."],
    ["unavailable", "The Vercel integration service is not running, so the Vercel account could not be checked."],
  ] as const)("fails a %s Vercel account", async (state, message) => {
    const result = await runPreflight(project, [web], deps({ credentialState: async () => state }));
    expect(byId(result, "credential:vercel")).toMatchObject({ status: "fail", message });
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
    const result = await runPreflight(withEnv("PORT"), [api], deps({}, files));
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

  it("counts the backend's URL as provided to a frontend with exactly one backend (Phase 9)", async () => {
    const files = { "frontend/.env.example": "NEXT_PUBLIC_API_URL=http://localhost:3001\n" };
    const nextWeb = { ...web, framework: "nextjs" };
    const alone = await runPreflight(project, [nextWeb], deps({}, files));
    const withApi = await runPreflight(project, [nextWeb, api], deps({}, files));
    expect(byId(alone, "env:c1")).toMatchObject({ status: "fail", message: expect.stringContaining("Add it under web → Environment.") });
    expect(byId(withApi, "env:c1")?.status).toBe("pass");
  });

  it("asks per component, and points a backend at Shared too", async () => {
    const files = { "backend/.env.example": "STRIPE_KEY=\n" };
    const result = await runPreflight(project, [api], deps({}, files));
    expect(byId(result, "env:c2")?.message).toContain("Add it under api → Environment (or Shared).");
    const envFor = (c: PreflightComponent) => (c.id === "c2" ? { keys: ["STRIPE_KEY"], filled: new Set(["STRIPE_KEY"]) } : noEnv());
    const filled = await runPreflight({ userId: "u1", envFor }, [api], deps({}, files));
    expect(byId(filled, "env:c2")?.status).toBe("pass");
  });

  it("fails a stored key the provider sets itself, and adds no check otherwise", async () => {
    const reserved = await runPreflight(withEnv("RENDER_SERVICE_ID", "PORT"), [api], deps());
    expect(byId(reserved, "env-reserved:c2")).toMatchObject({ status: "fail", message: expect.stringContaining("RENDER_SERVICE_ID is set by Render itself") });
    expect(reserved.deployable.c2).toBe(false);
    const fine = await runPreflight(withEnv("PORT"), [api], deps());
    expect(byId(fine, "env-reserved:c2")).toBeUndefined();
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
