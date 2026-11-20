import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { open, seal } from "@/lib/crypto/secret-box";
import { EnvVarsService, sharedRowsFor } from "./env-vars.service";

type Row = { id: string; projectId: string; componentId: string | null; key: string; valueEnc: string; isSecret: boolean; createdAt: Date; updatedAt: Date };
type Comp = { id: string; projectId: string; kind: "frontend" | "backend" | "database"; provider: string; name: string; rootDir: string; framework: string | null; buildCmd: string | null; providerResourceId: string | null; envRevision: number };

/** Just enough Prisma for EnvVarsService, in memory. */
function fakeDb() {
  let seq = 0;
  const rows: Row[] = [];
  const projects = new Map<string, { id: string; userId: string; name: string; envVars: unknown }>();
  const components = new Map<string, Comp>();
  const deployments: Array<{ componentId: string; status: string; envRevision: number | null; queuedAt: Date }> = [];

  const matches = (row: Row, where: Record<string, unknown>): boolean => {
    if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
    if ("componentId" in where && row.componentId !== where.componentId) return false;
    if (where.key !== undefined && row.key !== where.key) return false;
    if (where.id && typeof where.id === "object" && "in" in (where.id as object)) {
      if (!(where.id as { in: string[] }).in.includes(row.id)) return false;
    }
    if (Array.isArray(where.OR)) return (where.OR as Record<string, unknown>[]).some((w) => matches(row, w));
    return true;
  };

  const envVar = {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((r) => matches(r, where)).sort((a, b) => a.key.localeCompare(b.key)),
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
    createMany: vi.fn(async ({ data }: { data: Omit<Row, "id" | "createdAt" | "updatedAt">[] }) => {
      for (const d of data) rows.push({ ...d, id: `ev${++seq}`, createdAt: new Date(), updatedAt: new Date() });
    }),
  };

  const prisma = {
    envVar,
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null),
      findMany: vi.fn(async () => [...projects.values()]),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(projects.get(where.id)!, data)),
    },
    component: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => components.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) => [...components.values()].filter((c) => c.projectId === where.projectId)),
      update: vi.fn(async ({ where }: { where: { id: string } }) => {
        components.get(where.id)!.envRevision++;
      }),
      updateMany: vi.fn(async ({ where }: { where: { projectId: string; kind: string } }) => {
        for (const c of components.values()) if (c.projectId === where.projectId && c.kind === where.kind) c.envRevision++;
      }),
    },
    deployment: {
      findMany: vi.fn(async ({ where }: { where: { componentId: { in: string[] } } }) => {
        const out = new Map<string, { componentId: string; envRevision: number | null }>();
        for (const d of [...deployments].sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime())) {
          if (d.status === "success" && where.componentId.in.includes(d.componentId) && !out.has(d.componentId)) out.set(d.componentId, d);
        }
        return [...out.values()];
      }),
    },
    $transaction: vi.fn(async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]))),
  };

  projects.set("p1", { id: "p1", userId: "u1", name: "shop", envVars: {} });
  const comp = (c: Partial<Comp> & Pick<Comp, "id" | "kind" | "provider" | "name">): Comp => ({
    projectId: "p1",
    rootDir: c.kind === "frontend" ? "frontend" : "backend",
    framework: null,
    buildCmd: null,
    providerResourceId: null,
    envRevision: 0,
    ...c,
  });
  components.set("web", comp({ id: "web", kind: "frontend", provider: "vercel", name: "web", framework: "nextjs" }));
  components.set("api", comp({ id: "api", kind: "backend", provider: "render", name: "api", providerResourceId: "srv-1" }));
  components.set("db", comp({ id: "db", kind: "database", provider: "neon", name: "db", rootDir: "." }));

  return { prisma, rows, projects, components, deployments };
}

let db: ReturnType<typeof fakeDb>;
let events: { projectChanged: ReturnType<typeof vi.fn> };
let service: EnvVarsService;
const readRepoFile = vi.fn(async () => null as string | null);

beforeEach(() => {
  db = fakeDb();
  events = { projectChanged: vi.fn() };
  readRepoFile.mockReset().mockResolvedValue(null);
  service = new EnvVarsService(db.prisma as unknown as PrismaClient, events, readRepoFile);
});

describe("EnvVarsService.put and list", () => {
  it("adds sealed rows, lists keys only, and bumps the component's revision", async () => {
    const view = await service.put("u1", "p1", "api", {
      vars: [
        { key: "GREETING", value: "hi", isSecret: false },
        { key: "API_SECRET", value: "s3cr3t-value", isSecret: true },
      ],
    });

    expect(db.rows.map((r) => r.valueEnc.startsWith("v1."))).toEqual([true, true]);
    expect(open(db.rows.find((r) => r.key === "API_SECRET")!.valueEnc)).toBe("s3cr3t-value");
    const api = view.components.find((c) => c.componentId === "api")!;
    expect(api.vars.map((v) => [v.key, v.isSecret])).toEqual([
      ["API_SECRET", true],
      ["GREETING", false],
    ]);
    expect(api.revision).toBe(1);
    expect(JSON.stringify(view)).not.toContain("s3cr3t-value");
    expect(JSON.stringify(view)).not.toContain('"hi"');
    expect(events.projectChanged).toHaveBeenCalledWith("p1", "updated");
  });

  it("keeps a value that is not re-sent, updates a changed one and deletes keys left out", async () => {
    await service.put("u1", "p1", "api", {
      vars: [
        { key: "KEEP", value: "kept", isSecret: true },
        { key: "CHANGE", value: "old", isSecret: false },
        { key: "DROP", value: "x", isSecret: false },
      ],
    });
    await service.put("u1", "p1", "api", { vars: [{ key: "KEEP", isSecret: true }, { key: "CHANGE", value: "new", isSecret: false }] });

    expect(db.rows.map((r) => [r.key, open(r.valueEnc)]).sort()).toEqual([
      ["CHANGE", "new"],
      ["KEEP", "kept"],
    ]);
    expect(db.components.get("api")!.envRevision).toBe(2);
  });

  it("does not bump the revision when nothing changed", async () => {
    await service.put("u1", "p1", "api", { vars: [{ key: "A", value: "1", isSecret: false }] });
    await service.put("u1", "p1", "api", { vars: [{ key: "A", value: "1", isSecret: false }] });
    await service.put("u1", "p1", "api", { vars: [{ key: "A", isSecret: false }] });
    expect(db.components.get("api")!.envRevision).toBe(1);
  });

  it("needs a value for a new key, and to make a secret readable", async () => {
    await expect(service.put("u1", "p1", "api", { vars: [{ key: "NEW", isSecret: true }] })).rejects.toMatchObject({
      status: 400,
      code: "env_value_required",
    });
    await service.put("u1", "p1", "api", { vars: [{ key: "TOKEN", value: "t", isSecret: true }] });
    await expect(service.put("u1", "p1", "api", { vars: [{ key: "TOKEN", isSecret: false }] })).rejects.toMatchObject({
      code: "env_value_required",
    });
    // Re-entering the value is fine; and a readable var may become a secret without one.
    await service.put("u1", "p1", "api", { vars: [{ key: "TOKEN", value: "t2", isSecret: false }] });
    await service.put("u1", "p1", "api", { vars: [{ key: "TOKEN", isSecret: true }] });
    expect(db.rows[0]).toMatchObject({ key: "TOKEN", isSecret: true });
  });

  it("applies the scope's rules: a public prefix cannot be a secret on a frontend", async () => {
    await expect(service.put("u1", "p1", "web", { vars: [{ key: "NEXT_PUBLIC_X", value: "v", isSecret: true }] })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("NEXT_PUBLIC_X cannot be a secret"),
    });
    await expect(service.put("u1", "p1", null, { vars: [{ key: "RENDER_SERVICE_ID", value: "v", isSecret: false }] })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("bumps every backend for a shared change, and refuses database and foreign components", async () => {
    await service.put("u1", "p1", null, { vars: [{ key: "SHARED", value: "s", isSecret: true }] });
    expect(db.components.get("api")!.envRevision).toBe(1);
    expect(db.components.get("web")!.envRevision).toBe(0);

    await expect(service.put("u1", "p1", "db", { vars: [] })).rejects.toMatchObject({ status: 400 });
    await expect(service.put("u2", "p1", "api", { vars: [] })).rejects.toMatchObject({ status: 404 });
    await expect(service.list("u2", "p1")).rejects.toMatchObject({ status: 404 });
  });

  it("flags a deployed component whose saved env is newer than its last successful deploy", async () => {
    db.deployments.push({ componentId: "api", status: "success", envRevision: 0, queuedAt: new Date() });
    let view = await service.list("u1", "p1");
    expect(view.components.find((c) => c.componentId === "api")!.pendingRedeploy).toBe(false);

    await service.put("u1", "p1", "api", { vars: [{ key: "A", value: "1", isSecret: false }] });
    view = await service.list("u1", "p1");
    expect(view.components.find((c) => c.componentId === "api")!.pendingRedeploy).toBe(true);
    // Never deployed: nothing to redeploy.
    await service.put("u1", "p1", "web", { vars: [{ key: "B", value: "1", isSecret: false }] });
    expect((await service.list("u1", "p1")).components.find((c) => c.componentId === "web")!.pendingRedeploy).toBe(false);

    db.deployments.push({ componentId: "api", status: "success", envRevision: 1, queuedAt: new Date(Date.now() + 1000) });
    view = await service.list("u1", "p1");
    expect(view.components.find((c) => c.componentId === "api")!.pendingRedeploy).toBe(false);
  });

  it("lists the system keys of each component", async () => {
    const view = await service.list("u1", "p1");
    expect(view.components.find((c) => c.componentId === "api")!.system.map((s) => s.key)).toEqual(["DATABASE_URL", "DATABASE_URL_UNPOOLED"]);
    expect(view.components.find((c) => c.componentId === "web")!.system.map((s) => s.key)).toEqual(["NEXT_PUBLIC_API_URL"]);
    expect(view.components.map((c) => c.kind)).toEqual(["frontend", "backend", "database"]);
  });
});

describe("EnvVarsService.reveal", () => {
  it("shows a non-secret value and refuses a secret", async () => {
    await service.put("u1", "p1", "api", {
      vars: [
        { key: "GREETING", value: "hi", isSecret: false },
        { key: "TOKEN", value: "t", isSecret: true },
      ],
    });
    await expect(service.reveal("u1", "p1", "api", "GREETING")).resolves.toEqual({ key: "GREETING", value: "hi" });
    await expect(service.reveal("u1", "p1", "api", "TOKEN")).rejects.toMatchObject({ status: 403, code: "env_secret" });
    await expect(service.reveal("u1", "p1", "api", "MISSING")).rejects.toMatchObject({ status: 404 });
    await expect(service.reveal("u2", "p1", "api", "GREETING")).rejects.toMatchObject({ status: 404 });
  });
});

describe("EnvVarsService.resolve and keysFor", () => {
  beforeEach(async () => {
    await service.put("u1", "p1", null, {
      vars: [
        { key: "SHARED", value: "s", isSecret: false },
        { key: "BOTH", value: "shared", isSecret: false },
      ],
    });
    await service.put("u1", "p1", "api", {
      vars: [
        { key: "BOTH", value: "own", isSecret: true },
        { key: "EMPTY", value: "", isSecret: false },
      ],
    });
    await service.put("u1", "p1", "web", { vars: [{ key: "NEXT_PUBLIC_X", value: "x", isSecret: false }] });
  });

  it("gives a backend shared + its own (own wins), a frontend its own, Docker the shared set, a database nothing", async () => {
    const api = await service.resolve("p1", { id: "api", kind: "backend" });
    expect(api.vars).toEqual([
      { key: "BOTH", value: "own", secret: true },
      { key: "EMPTY", value: "", secret: false },
      { key: "SHARED", value: "s", secret: false },
    ]);
    expect(api.secrets).toEqual(["own"]);
    expect(api.revision).toBe(2); // the shared change + its own

    expect((await service.resolve("p1", { id: "web", kind: "frontend" })).vars).toEqual([{ key: "NEXT_PUBLIC_X", value: "x", secret: false }]);
    expect((await service.resolve("p1", null)).vars.map((v) => v.key)).toEqual(["BOTH", "SHARED"]);
    expect(await service.resolve("p1", { id: "db", kind: "database" })).toEqual({ vars: [], secrets: [], revision: 0 });
  });

  it("reports stored and filled keys by the same scopes", async () => {
    const envFor = await service.keysFor("p1");
    const api = envFor({ id: "api", kind: "backend" });
    expect(api.keys.sort()).toEqual(["BOTH", "EMPTY", "SHARED"]);
    expect([...api.filled].sort()).toEqual(["BOTH", "SHARED"]);
    expect(envFor({ id: "web", kind: "frontend" }).keys).toEqual(["NEXT_PUBLIC_X"]);
  });
});

describe("EnvVarsService.suggestions", () => {
  it("lists .env.example keys, hiding example values of secret-looking keys", async () => {
    await service.put("u1", "p1", null, { vars: [{ key: "PORT", value: "3000", isSecret: false }] });
    readRepoFile.mockResolvedValueOnce("PORT=8080\nSTRIPE_SECRET_KEY=sk_test_placeholder\nGREETING=hello # comment\nDATABASE_URL=\n");

    const result = await service.suggestions("u1", "p1", "api");

    expect(readRepoFile).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), "backend/.env.example");
    expect(result).toEqual({
      path: "backend/.env.example",
      found: true,
      suggestions: [
        { key: "PORT", example: "8080", looksSecret: false, alreadySet: true, providedBySystem: false },
        { key: "STRIPE_SECRET_KEY", example: null, looksSecret: true, alreadySet: false, providedBySystem: false },
        { key: "GREETING", example: "hello", looksSecret: false, alreadySet: false, providedBySystem: false },
        { key: "DATABASE_URL", example: null, looksSecret: true, alreadySet: false, providedBySystem: true },
      ],
    });
  });

  it("says when there is no .env.example", async () => {
    await expect(service.suggestions("u1", "p1", "web")).resolves.toEqual({ path: "frontend/.env.example", found: false, suggestions: [] });
  });
});

describe("EnvVarsService.migrateLegacy", () => {
  it("moves the old JSON into sealed shared secrets once, without bumping revisions", async () => {
    db.projects.get("p1")!.envVars = { GREETING: "hi", TOKEN: "t" };

    await expect(service.migrateLegacy()).resolves.toBe(1);
    await expect(service.migrateLegacy()).resolves.toBe(0);

    expect(db.projects.get("p1")!.envVars).toEqual({});
    expect(db.rows.map((r) => [r.key, r.componentId, r.isSecret, open(r.valueEnc)]).sort()).toEqual([
      ["GREETING", null, true, "hi"],
      ["TOKEN", null, true, "t"],
    ]);
    expect(db.components.get("api")!.envRevision).toBe(0);
  });
});

describe("sharedRowsFor", () => {
  it("seals a new project's vars as shared secrets, and refuses a bad key", () => {
    const rows = sharedRowsFor("p9", { A: "1" });
    expect(rows).toEqual([{ projectId: "p9", componentId: null, key: "A", valueEnc: expect.stringMatching(/^v1\./), isSecret: true }]);
    expect(open(rows[0].valueEnc)).toBe("1");
    expect(() => sharedRowsFor("p9", { "bad-key": "1" })).toThrow(/not a valid variable name/);
    expect(seal("x")).not.toBe(seal("x"));
  });
});
