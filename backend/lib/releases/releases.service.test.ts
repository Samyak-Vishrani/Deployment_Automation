import type { Deployment, PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventsService } from "@/lib/events/events.service";
import { DONE_STAGE, ReleasesService } from "./releases.service";

const SHA = "e".repeat(40);

const project = {
  id: "p1",
  userId: "u1",
  name: "shop",
  repoFullName: "me/shop",
  githubFullName: "me/shop",
  owner: "me",
  repo: "shop",
  branch: "main",
  defaultBranch: "main",
  installationId: "inst1",
};

const comp = (id: string, kind: string, provider: string, name = id) => ({
  id,
  projectId: "p1",
  kind,
  name,
  rootDir: kind === "database" ? "." : kind,
  provider,
  url: null,
  status: "configured",
  createdAt: new Date(),
});

type Row = Record<string, unknown>;

/** Just enough of Prisma for the release service, in memory. */
function fakePrisma(components: Row[]) {
  const releases = new Map<string, Row>();
  const deployments = new Map<string, Row>();
  const pick = (map: Map<string, Row>, where: Row) =>
    [...map.values()].filter((r) =>
      Object.entries(where).every(([k, v]) =>
        v && typeof v === "object" && "in" in (v as Row) ? ((v as { in: unknown[] }).in).includes(r[k]) : r[k] === v,
      ),
    );
  const prisma = {
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "p1" ? { ...project } : null)),
    },
    component: {
      findMany: vi.fn(async ({ where }: { where: Row }) => components.filter((c) => pick(new Map([["x", c]]), where).length > 0)),
    },
    release: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
        const rows = pick(releases, where);
        if (orderBy) rows.sort((a, b) => (b.number as number) - (a.number as number));
        return rows[0] ?? null;
      }),
      findUnique: vi.fn(async ({ where, include }: { where: { id: string }; include?: Row }) => {
        const r = releases.get(where.id);
        if (!r) return null;
        return {
          ...r,
          ...(include?.deployments ? { deployments: pick(deployments, { releaseId: r.id }) } : {}),
          ...(include?.project ? { project: { ...project } } : {}),
        };
      }),
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        pick(releases, where).map((r) => ({ ...r, deployments: pick(deployments, { releaseId: r.id }) })),
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `rel${releases.size + 1}`, status: "running", stage: 0, errorMessage: null, finishedAt: null, createdAt: new Date(), ...data };
        releases.set(row.id as string, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = { ...releases.get(where.id)!, ...data };
        releases.set(where.id, row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hits = pick(releases, where);
        for (const h of hits) releases.set(h.id as string, { ...h, ...data });
        return { count: hits.length };
      }),
    },
    deployment: {
      findMany: vi.fn(async ({ where }: { where: Row }) => pick(deployments, where)),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return { prisma, releases, deployments };
}

function setup(components = [comp("db", "database", "neon"), comp("api", "backend", "render"), comp("web", "frontend", "vercel")]) {
  const { prisma, releases, deployments } = fakePrisma(components);
  let listener: ((d: Deployment) => void) | undefined;
  let seq = 0;
  const providers = {
    deployComponent: vi.fn(async (_userId: string, projectId: string, componentId: string, options: Row) => {
      const row = {
        id: `dep${++seq}`,
        projectId,
        componentId,
        provider: components.find((c) => c.id === componentId)!.provider,
        status: "queued",
        providerStatus: "queued",
        url: null,
        errorMessage: null,
        queuedAt: new Date(Date.now() + seq),
        finishedAt: null,
        releaseId: options.releaseId,
      };
      deployments.set(row.id, row);
      return row as unknown as Deployment;
    }),
    cancel: vi.fn(async (d: Deployment) => {
      finishDeployment(d.id, "cancelled");
      return { status: "cancelling" };
    }),
    onDeploymentFinished: vi.fn((fn: (d: Deployment) => void) => {
      listener = fn;
    }),
  };
  const events = { releaseChanged: vi.fn() };
  const github = { getBranchHeadSha: vi.fn(async () => SHA), resolveInstallationId: vi.fn(async () => "inst1") };
  const components_ = { preflight: vi.fn(async () => ({ ok: true, checks: [], deployable: {} })) };
  const sink = { write: vi.fn(async () => undefined) };

  const service = new ReleasesService(
    prisma as unknown as PrismaClient,
    github,
    events as unknown as EventsService,
    components_ as never,
    providers as never,
    sink as never,
  );

  /** What a provider's terminal event does: the row finishes, the listener is told. */
  function finishDeployment(id: string, status: "success" | "failed" | "cancelled", errorMessage: string | null = null) {
    const row = { ...deployments.get(id)!, status, errorMessage, finishedAt: new Date() };
    deployments.set(id, row);
    listener?.(row as unknown as Deployment);
  }
  const deploymentOf = (componentId: string) => [...deployments.values()].find((d) => d.componentId === componentId);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  return { service, prisma, releases, deployments, providers, events, github, preflight: components_.preflight, sink, finishDeployment, deploymentOf, settle };
}

describe("ReleasesService", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("deploys database, then backend, then frontend, each stage only after the one before is live", async () => {
    const view = await ctx.service.start("u1", "p1");
    expect(view).toMatchObject({ number: 1, status: "running", stage: 0, commitSha: SHA });
    expect(ctx.providers.deployComponent).toHaveBeenCalledTimes(1);
    expect(ctx.providers.deployComponent).toHaveBeenLastCalledWith("u1", "p1", "db", expect.objectContaining({ releaseId: "rel1", commitSha: SHA }));

    ctx.finishDeployment(ctx.deploymentOf("db")!.id as string, "success");
    await ctx.settle();
    expect(ctx.providers.deployComponent).toHaveBeenCalledTimes(2);
    expect(ctx.providers.deployComponent).toHaveBeenLastCalledWith("u1", "p1", "api", expect.anything());
    expect(ctx.releases.get("rel1")).toMatchObject({ stage: 1, status: "running" });

    ctx.finishDeployment(ctx.deploymentOf("api")!.id as string, "success");
    await ctx.settle();
    expect(ctx.providers.deployComponent).toHaveBeenLastCalledWith("u1", "p1", "web", expect.anything());

    ctx.finishDeployment(ctx.deploymentOf("web")!.id as string, "success");
    await ctx.settle();
    expect(ctx.releases.get("rel1")).toMatchObject({ status: "success", stage: DONE_STAGE });
    expect(ctx.events.releaseChanged).toHaveBeenLastCalledWith("p1", "rel1", "success", DONE_STAGE);

    const done = await ctx.service.get("u1", "rel1");
    expect(done.steps.map((s) => [s.kind, s.deployment?.status])).toEqual([
      ["database", "success"],
      ["backend", "success"],
      ["frontend", "success"],
    ]);
  });

  it("stops at a failed stage and says what was not deployed", async () => {
    await ctx.service.start("u1", "p1");
    ctx.finishDeployment(ctx.deploymentOf("db")!.id as string, "success");
    await ctx.settle();
    ctx.finishDeployment(ctx.deploymentOf("api")!.id as string, "failed", "No open ports detected.");
    await ctx.settle();

    expect(ctx.releases.get("rel1")).toMatchObject({ status: "failed" });
    expect(ctx.releases.get("rel1")!.errorMessage).toMatch(/Backend api failed, so the frontend was not deployed\. No open ports/);
    expect(ctx.deploymentOf("web")).toBeUndefined();
  });

  it("skips stages with no component", async () => {
    ctx = setup([comp("api", "backend", "render"), comp("web", "frontend", "vercel")]);
    await ctx.service.start("u1", "p1");
    expect(ctx.providers.deployComponent).toHaveBeenLastCalledWith("u1", "p1", "api", expect.anything());
    expect(ctx.releases.get("rel1")).toMatchObject({ stage: 1 });
  });

  it("advances only once however often it is told", async () => {
    await ctx.service.start("u1", "p1");
    const dbId = ctx.deploymentOf("db")!.id as string;
    ctx.finishDeployment(dbId, "success");
    ctx.finishDeployment(dbId, "success");
    await Promise.all([ctx.service.advance("rel1"), ctx.service.advance("rel1")]);
    await ctx.settle();
    expect(ctx.providers.deployComponent.mock.calls.filter((c) => c[2] === "api")).toHaveLength(1);
  });

  it("fails the release when a deploy cannot even start", async () => {
    ctx.providers.deployComponent.mockRejectedValueOnce(new Error("Connect Neon in Settings first."));
    const view = await ctx.service.start("u1", "p1");
    expect(view.status).toBe("failed");
    expect(view.errorMessage).toMatch(/Database db could not start: Connect Neon/);
  });

  it("cancels: marks the release, cancels running deploys, and starts nothing more", async () => {
    await ctx.service.start("u1", "p1");
    ctx.finishDeployment(ctx.deploymentOf("db")!.id as string, "success");
    await ctx.settle();

    const view = await ctx.service.cancel("u1", "rel1");
    await ctx.settle();
    expect(view.status).toBe("cancelled");
    expect(ctx.providers.cancel).toHaveBeenCalledWith(expect.objectContaining({ componentId: "api" }));
    expect(ctx.deploymentOf("web")).toBeUndefined();
  });

  it("refuses a second release while one runs, and one whose pre-flight fails", async () => {
    await ctx.service.start("u1", "p1");
    await expect(ctx.service.start("u1", "p1")).rejects.toMatchObject({ status: 409, code: "release_in_progress" });

    const fresh = setup();
    fresh.preflight.mockResolvedValueOnce({
      ok: false,
      checks: [{ id: "credential:neon", status: "fail", message: "Connect Neon in Settings to deploy there." }],
      deployable: {},
    } as never);
    await expect(fresh.service.start("u1", "p1")).rejects.toMatchObject({ status: 412, code: "preflight_failed" });
    expect(fresh.providers.deployComponent).not.toHaveBeenCalled();
  });

  it("numbers releases per project, and hides them from other users", async () => {
    await ctx.service.start("u1", "p1");
    ctx.releases.set("rel1", { ...ctx.releases.get("rel1")!, status: "success" });
    const second = await ctx.service.start("u1", "p1");
    expect(second.number).toBe(2);

    await expect(ctx.service.get("intruder", "rel1")).rejects.toMatchObject({ status: 404 });
    await expect(ctx.service.start("intruder", "p1")).rejects.toMatchObject({ status: 404 });
  });

  it("resumes running releases after a restart", async () => {
    await ctx.service.start("u1", "p1");
    // A restart loses the listener's call: the stage finished while nobody listened.
    const dbId = ctx.deploymentOf("db")!.id as string;
    ctx.deployments.set(dbId, { ...ctx.deployments.get(dbId)!, status: "success" });
    await expect(ctx.service.resumeAll()).resolves.toBe(1);
    expect(ctx.providers.deployComponent).toHaveBeenLastCalledWith("u1", "p1", "api", expect.anything());
  });
});
