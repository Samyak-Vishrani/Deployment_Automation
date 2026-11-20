import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { buildLogsIndex } from "./logs-index";
import { containerName, RuntimeLogsService, type BrowserRuntimeEvent } from "./runtime-logs.service";

const project = { id: "p1", userId: "u1", slug: "shop", containerId: "abc" };
const components: Record<string, object> = {
  web: { id: "web", projectId: "p1", kind: "frontend", provider: "vercel", name: "web", providerResourceId: "prj_1" },
  api: { id: "api", projectId: "p1", kind: "backend", provider: "render", name: "api", providerResourceId: "srv-1" },
  db: { id: "db", projectId: "p1", kind: "database", provider: "neon", name: "db", providerResourceId: "young-1" },
};

function prismaFake(deployments: object[] = [], releases: object[] = []) {
  return {
    project: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "p1" ? project : null)) },
    component: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => components[where.id] ?? null),
      findFirst: vi.fn(async () => components.db),
      findMany: vi.fn(async () => Object.values(components)),
    },
    deployment: {
      findMany: vi.fn(async ({ where }: { where: { componentId: string | null } }) =>
        deployments.filter((d) => (d as { componentId: string | null }).componentId === where.componentId),
      ),
    },
    release: { findMany: vi.fn(async () => releases) },
  } as unknown as PrismaClient;
}

const ndjson = (...events: object[]) =>
  new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { headers: { "x-session-id": "sess-1" } });

const collect = async (gen: AsyncGenerator<BrowserRuntimeEvent>) => {
  const out: BrowserRuntimeEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

function setup(response: Response = ndjson()) {
  const client = {
    openRuntime: vi.fn(async () => response),
    openDockerRuntime: vi.fn(async () => response),
    ping: vi.fn(async () => ({ ok: true as const })),
  };
  const envVars = { resolve: vi.fn(async () => ({ vars: [], secrets: ["sk_live_secret_value"], revision: 1 })) };
  const neon = { getConnection: vi.fn(async () => ({ pooledUri: "postgres://u:pw@pooled/db", directUri: "postgres://u:pw@direct/db" })) };
  const service = new RuntimeLogsService(prismaFake(), client, envVars, neon);
  return { service, client, envVars, neon };
}

const signal = () => new AbortController().signal;

describe("RuntimeLogsService", () => {
  it("streams one Render component, tagging the source and redacting its secret env values and Neon URLs", async () => {
    const ctx = setup(
      ndjson(
        { type: "notice", text: "Connected to Render." },
        { type: "line", line: { id: "l1", at: 1, stream: "stdout", text: "using sk_live_secret_value and postgres://u:pw@pooled/db" } },
        { type: "heartbeat" },
        { type: "end", reason: "idle", message: "Stopped." },
      ),
    );
    const opened = await ctx.service.open("u1", "p1", "api", { since: "15m", requests: true }, signal());
    expect(opened).toMatchObject({ sessionId: "sess-1", source: "render" });
    expect(ctx.client.openRuntime).toHaveBeenCalledWith("u1", "api", "render", { since: "15m", requests: true }, expect.any(AbortSignal));
    const events = await collect(opened.events);
    expect(events).toEqual([
      { type: "notice", text: "Connected to Render." },
      { type: "entry", entry: { id: "l1", at: 1, stream: "stdout", text: "using ***REDACTED*** and ***REDACTED***", source: "render" } },
      { type: "end", reason: "idle", message: "Stopped." },
    ]);
  });

  it("explains Neon has no runtime logs, and hides other users' projects and components", async () => {
    const ctx = setup();
    await expect(ctx.service.open("u1", "p1", "db", { since: "15m" }, signal())).rejects.toMatchObject({ status: 400, code: "runtime_logs_unsupported" });
    await expect(ctx.service.open("u2", "p1", "api", { since: "15m" }, signal())).rejects.toMatchObject({ status: 404 });
    await expect(ctx.service.open("u1", "p1", "nope", { since: "15m" }, signal())).rejects.toMatchObject({ status: 404 });
    expect(ctx.client.openRuntime).not.toHaveBeenCalled();
  });

  it("tails the project's Docker container by its OrbitOps name", async () => {
    const ctx = setup(ndjson({ type: "line", line: { id: "docker:1", at: 1, stream: "stderr", text: "boom" } }));
    const opened = await ctx.service.open("u1", "p1", null, { since: "5m" }, signal());
    expect(ctx.client.openDockerRuntime).toHaveBeenCalledWith("u1", "orbitops-shop", { since: "5m" }, expect.any(AbortSignal));
    expect((await collect(opened.events))[0]).toMatchObject({ type: "entry", entry: { source: "docker", stream: "stderr" } });
    expect(containerName({ slug: null, id: "cmABC" })).toBe("orbitops-cmabc");
  });

  it("lets only the stream's owner ping it, and forgets it once it ends", async () => {
    const ctx = setup(ndjson({ type: "notice", text: "hi" }));
    const opened = await ctx.service.open("u1", "p1", "web", { since: "15m" }, signal());
    await expect(ctx.service.ping("u2", "sess-1")).rejects.toMatchObject({ status: 404 });
    await expect(ctx.service.ping("u1", "sess-1")).resolves.toEqual({ ok: true });
    await collect(opened.events);
    await expect(ctx.service.ping("u1", "sess-1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("buildLogsIndex", () => {
  const d = (id: string, componentId: string | null, over: object = {}) => ({
    id,
    componentId,
    status: "success",
    trigger: "manual",
    queuedAt: new Date(2026, 10, 4),
    finishedAt: null,
    commitSha: "a".repeat(40),
    commitMessage: "msg",
    releaseId: null,
    provider: componentId ? "vercel" : "local_docker",
    ...over,
  });

  it("lists each component with only its own deployments, in frontend, backend, database order", async () => {
    const prisma = prismaFake([d("d1", "web", { releaseId: "r1" }), d("d2", "api", { status: "failed" }), d("d3", null)], [{ id: "r1", number: 7 }]);
    const index = await buildLogsIndex(prisma, "u1", "p1");
    expect(index.components.map((c) => [c.name, c.runtime, c.deployments.map((x) => x.id)])).toEqual([
      ["web", "available", ["d1"]],
      ["api", "not_deployed", ["d2"]],
      ["db", "unsupported", []],
    ]);
    expect(index.components[0].deployments[0].releaseNumber).toBe(7);
    expect(index.components[2].runtimeNote).toMatch(/Neon has no runtime log API/);
    expect(index.docker).toMatchObject({ runtime: "available", deployments: [{ id: "d3" }] });
  });

  it("has no Docker entry without local Docker deploys, and hides other users' projects", async () => {
    expect((await buildLogsIndex(prismaFake([d("d1", "web")]), "u1", "p1")).docker).toBeNull();
    await expect(buildLogsIndex(prismaFake(), "u2", "p1")).rejects.toMatchObject({ status: 404 });
  });
});
