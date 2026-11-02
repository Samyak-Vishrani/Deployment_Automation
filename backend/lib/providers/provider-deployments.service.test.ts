import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/api/http-error";
import type { EventsService } from "@/lib/events/events.service";
import type { PushPayload } from "@/lib/deployments/push-payload";
import { lifecycleStatus, ProviderDeploymentsService } from "./provider-deployments.service";
import type { ProviderLogSink } from "./provider-log-sink";
import type { VercelServiceClient } from "./vercel-service.client";

const SHA = "d".repeat(40);

const project = {
  id: "p1",
  userId: "u1",
  name: "shop",
  repoFullName: "me/shop",
  githubFullName: "me/shop",
  owner: "me",
  repo: "shop",
  repoId: 42,
  branch: "main",
  defaultBranch: "main",
  installationId: "inst1",
};

const component = {
  id: "c1",
  projectId: "p1",
  kind: "frontend",
  name: "web",
  rootDir: "frontend",
  framework: "nextjs",
  installCmd: null,
  buildCmd: null,
  startCmd: null,
  outputDir: null,
  nodeVersion: null,
  provider: "vercel",
  providerResourceId: null as string | null,
  url: null as string | null,
  status: "configured",
};

function setup() {
  const deployments = new Map<string, Record<string, unknown>>();
  const components = new Map<string, Record<string, unknown>>([["c1", { ...component }]]);

  const prisma = {
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "p1" ? { ...project } : null)),
      findMany: vi.fn(async () => [{ ...project, deployComponents: [...components.values()] }]),
    },
    component: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => components.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        const row = { ...components.get(where.id)!, ...data };
        components.set(where.id, row);
        return row;
      }),
    },
    deployment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `dep${deployments.size + 1}`, providerEventSeq: 0, startedAt: null, finishedAt: null, ...data };
        deployments.set(row.id as string, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = deployments.get(where.id);
        return row ? { ...row, component: components.get(row.componentId as string) ?? null } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        const row = { ...deployments.get(where.id)!, ...data };
        deployments.set(where.id, row);
        return row;
      }),
      findMany: vi.fn(async () => []),
    },
  };
  const github = {
    getBranchHeadSha: vi.fn(async () => SHA),
    getInstallationToken: vi.fn(async () => "ghs_token"),
    resolveInstallationId: vi.fn(async () => "inst1"),
    getRepoMetadata: vi.fn(),
  };
  const events = { deploymentChanged: vi.fn(), projectChanged: vi.fn() };
  const vercel = {
    getCredential: vi.fn(async () => ({ state: "connected" })),
    startDeployment: vi.fn(async () => ({})),
    cancelDeployment: vi.fn(async () => ({})),
    getDeployment: vi.fn(),
  };
  const sink = {
    write: vi.fn(async () => undefined),
    section: vi.fn(async () => undefined),
    close: vi.fn(async () => "tail"),
  };

  const service = new ProviderDeploymentsService(
    prisma as unknown as PrismaClient,
    github as never,
    events as unknown as EventsService,
    vercel as unknown as VercelServiceClient,
    sink as unknown as ProviderLogSink,
  );
  return { service, prisma, github, events, vercel, sink, deployments, components };
}

describe("lifecycleStatus", () => {
  it("maps provider progress onto the five deployment statuses", () => {
    expect(lifecycleStatus("queued")).toBe("running");
    expect(lifecycleStatus("building")).toBe("running");
    expect(lifecycleStatus("live")).toBe("success");
    expect(lifecycleStatus("failed")).toBe("failed");
    expect(lifecycleStatus("cancelled")).toBe("cancelled");
  });
});

describe("deployComponent", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("queues a deployment at the branch head and hands it to the integration service", async () => {
    const deployment = await ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" });

    expect(deployment).toMatchObject({ provider: "vercel", componentId: "c1", status: "queued", commitSha: SHA });
    expect(ctx.vercel.startDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: deployment!.id,
        userId: "u1",
        commitSha: SHA,
        githubToken: "ghs_token",
        repo: { fullName: "me/shop", repoId: 42, branch: "main" },
        component: expect.objectContaining({ id: "c1", rootDir: "frontend", framework: "nextjs" }),
      }),
    );
    expect(ctx.events.deploymentChanged).toHaveBeenCalledWith("p1", deployment!.id, "queued");
  });

  it("answers 404 for someone else's project", async () => {
    await expect(ctx.service.deployComponent("intruder", "p1", "c1", { trigger: "manual" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("asks for a Vercel account before creating anything", async () => {
    ctx.vercel.getCredential.mockResolvedValueOnce({ state: "missing" });
    await expect(ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" })).rejects.toMatchObject({
      status: 412,
      code: "vercel_not_connected",
    });
    expect(ctx.prisma.deployment.create).not.toHaveBeenCalled();
  });

  it("refuses providers that arrive in later phases", async () => {
    ctx.components.set("c1", { ...component, provider: "render" });
    await expect(ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" })).rejects.toThrow(/Phase 7/);
  });

  it("marks the row failed when the integration service cannot be reached", async () => {
    ctx.vercel.startDeployment.mockRejectedValueOnce(new HttpError("The Vercel integration service is not running.", 503));
    await expect(ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" })).rejects.toThrow(/not running/);
    const row = [...ctx.deployments.values()][0];
    expect(row).toMatchObject({ status: "failed", errorMessage: "The Vercel integration service is not running." });
    expect(ctx.sink.close).toHaveBeenCalled();
  });
});

describe("applyBatch", () => {
  let ctx: ReturnType<typeof setup>;
  let id: string;
  beforeEach(async () => {
    ctx = setup();
    id = (await ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" }))!.id;
  });

  it("applies a run end to end: status, resource, deployment, logs, terminal", async () => {
    await ctx.service.applyBatch({
      deploymentId: id,
      seq: 1,
      events: [
        { type: "status", providerStatus: "deploying" },
        { type: "resource", componentId: "c1", providerResourceId: "prj_1", projectName: "shop-web" },
        { type: "deployment", providerDeploymentId: "dpl_1", sourceMode: "git", url: "https://a.vercel.app", inspectorUrl: "https://vercel.com/i" },
        { type: "logs", lines: [{ at: 1, stream: "stdout", text: "compiled" }] },
      ],
    });
    expect(ctx.deployments.get(id)).toMatchObject({
      status: "running",
      providerStatus: "deploying",
      providerDeploymentId: "dpl_1",
      sourceMode: "git",
      providerEventSeq: 1,
    });
    expect(ctx.components.get("c1")).toMatchObject({ providerResourceId: "prj_1", status: "deploying" });
    expect(ctx.sink.write).toHaveBeenCalledWith("p1", id, ["compiled"]);

    await ctx.service.applyBatch({
      deploymentId: id,
      seq: 2,
      events: [
        { type: "status", providerStatus: "live" },
        { type: "terminal", status: "live", productionUrl: "https://shop-web.vercel.app" },
      ],
    });
    expect(ctx.deployments.get(id)).toMatchObject({ status: "success", providerStatus: "live", logTail: "tail" });
    expect(ctx.components.get("c1")).toMatchObject({ status: "live", url: "https://shop-web.vercel.app" });
    expect(ctx.events.deploymentChanged).toHaveBeenLastCalledWith("p1", id, "success");
  });

  it("ignores a redelivered batch", async () => {
    const batch = { deploymentId: id, seq: 1, events: [{ type: "logs" as const, lines: [{ at: 1, stream: "stdout" as const, text: "once" }] }] };
    await expect(ctx.service.applyBatch(batch)).resolves.toEqual({ applied: true });
    await expect(ctx.service.applyBatch(batch)).resolves.toEqual({ applied: false });
    expect(ctx.sink.write).toHaveBeenCalledTimes(1);
  });

  it("keeps a previously live component live when a new deploy is cancelled", async () => {
    ctx.components.set("c1", { ...ctx.components.get("c1")!, url: "https://old.vercel.app", status: "live" });
    await ctx.service.applyBatch({ deploymentId: id, seq: 1, events: [{ type: "terminal", status: "cancelled" }] });
    expect(ctx.components.get("c1")).toMatchObject({ status: "live" });
    expect(ctx.deployments.get(id)).toMatchObject({ status: "cancelled" });
  });

  it("answers 404 for an unknown deployment so the service stops retrying", async () => {
    await expect(ctx.service.applyBatch({ deploymentId: "nope", seq: 1, events: [] })).rejects.toMatchObject({ status: 404 });
  });
});

describe("handlePush", () => {
  const push = (files: string[]): PushPayload =>
    ({
      ref: "refs/heads/main",
      after: SHA,
      repository: { id: 42, full_name: "me/shop" },
      head_commit: { id: SHA, message: "change", added: files, modified: [], removed: [] },
      commits: [{ id: SHA, message: "change", added: files, modified: [], removed: [] }],
    }) as unknown as PushPayload;

  it("redeploys a deployed Vercel component when its folder changed, and only then", async () => {
    const ctx = setup();
    ctx.components.set("c1", { ...component, providerResourceId: "prj_1" });

    await expect(ctx.service.handlePush(push(["backend/server.ts"]), "del1")).resolves.toBe(0);
    await expect(ctx.service.handlePush(push(["frontend/app/page.tsx"]), "del2")).resolves.toBe(1);
    expect(ctx.prisma.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "push", deliveryId: "del2:c1", commitSha: SHA }) }),
    );
  });
});
