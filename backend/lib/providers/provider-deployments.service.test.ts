import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/api/http-error";
import type { ResolvedEnv } from "@/lib/env/env-vars.service";
import type { EventsService } from "@/lib/events/events.service";
import type { PushPayload } from "@/lib/deployments/push-payload";
import { lifecycleStatus, ProviderDeploymentsService } from "./provider-deployments.service";
import type { NeonClient } from "./provider-deployments.service";
import type { ProviderLogSink } from "./provider-log-sink";
import type { RenderServiceClient } from "./render-service.client";
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
  envVars: { GREETING: "hi", "bad-key": "dropped" } as Record<string, string>,
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
  healthCheckPath: null as string | null,
  provider: "vercel",
  providerResourceId: null as string | null,
  url: null as string | null,
  status: "configured",
};

const POOLED = "postgresql://neondb_owner:npg_SECRETpw@ep-1-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require";
const DIRECT = "postgresql://neondb_owner:npg_SECRETpw@ep-1.us-west-2.aws.neon.tech/neondb?sslmode=require";

function setup() {
  const deployments = new Map<string, Record<string, unknown>>();
  const components = new Map<string, Record<string, unknown>>([["c1", { ...component }]]);
  const matching = (where: Record<string, unknown>) =>
    [...components.values()].filter((c) =>
      Object.entries(where).every(([key, value]) => (key === "provider" && typeof value === "object" ? true : c[key] === value)),
    );

  const prisma = {
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "p1" ? { ...project } : null)),
      findMany: vi.fn(async () => [{ ...project, deployComponents: [...components.values()] }]),
    },
    component: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => components.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => matching(where)[0] ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => matching(where)),
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
      findMany: vi.fn(async () => [...deployments.values()].filter((d) => d.status === "queued" || d.status === "running")),
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
    startDeployment: vi.fn<(request: unknown) => Promise<object>>(async () => ({})),
    cancelDeployment: vi.fn(async () => ({})),
    getDeployment: vi.fn(),
  };
  const render = {
    getCredential: vi.fn(async () => ({ state: "connected" })),
    startDeployment: vi.fn<(request: unknown) => Promise<object>>(async () => ({})),
    cancelDeployment: vi.fn(async () => ({})),
    getDeployment: vi.fn(),
  };
  const neon = {
    getCredential: vi.fn(async () => ({ state: "connected" })),
    ensureDatabase: vi.fn(async () => ({
      componentId: "db1",
      state: "ready",
      neonProjectId: "young-sun-1",
      name: "shop-database",
      regionId: "aws-us-west-2",
      pgVersion: 17,
      host: "ep-1.us-west-2.aws.neon.tech",
      databaseName: "neondb",
      roleName: "neondb_owner",
      consoleUrl: "https://console.neon.tech/app/projects/young-sun-1",
      created: true,
      warning: null,
      lastError: null,
    })),
    getDatabase: vi.fn(async () => ({ state: "ready", neonProjectId: "young-sun-1", consoleUrl: "https://console.neon.tech/app/projects/young-sun-1" })),
    getConnection: vi.fn(async () => ({ pooledUri: POOLED, directUri: DIRECT })),
  };
  const sink = {
    write: vi.fn(async () => undefined),
    section: vi.fn(async () => undefined),
    addSecrets: vi.fn(async () => undefined),
    close: vi.fn(async () => "tail"),
  };
  // Phase 9: what EnvVarsService.resolve would return for every component.
  const envVars = {
    resolve: vi.fn(async (): Promise<ResolvedEnv> => ({
      vars: [{ key: "GREETING", value: "hi", secret: false }],
      secrets: [],
      revision: 3,
    })),
  };

  const service = new ProviderDeploymentsService(
    prisma as unknown as PrismaClient,
    github as never,
    events as unknown as EventsService,
    { vercel: vercel as unknown as VercelServiceClient, render: render as unknown as RenderServiceClient },
    sink as unknown as ProviderLogSink,
    neon as unknown as NeonClient,
    envVars,
  );
  return { service, prisma, github, events, vercel, render, neon, sink, envVars, deployments, components };
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

  it("refuses local Docker components", async () => {
    ctx.components.set("c1", { ...component, provider: "local_docker" });
    await expect(ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" })).rejects.toThrow(/local Docker/);
  });

  it("sends a Render deploy the start command, health path and project env vars, but no GitHub token", async () => {
    ctx.components.set("c1", {
      ...component,
      kind: "backend",
      name: "api",
      rootDir: "backend",
      framework: "express",
      startCmd: "npm start",
      healthCheckPath: "/health",
      provider: "render",
    });
    const deployment = await ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" });

    expect(deployment).toMatchObject({ provider: "render", commitMessage: "Deploy api to Render" });
    expect(ctx.render.startDeployment).toHaveBeenCalledWith({
      deploymentId: deployment!.id,
      userId: "u1",
      component: expect.objectContaining({ id: "c1", startCmd: "npm start", healthCheckPath: "/health" }),
      repo: { fullName: "me/shop", branch: "main" },
      commitSha: SHA,
      envVars: [{ key: "GREETING", value: "hi" }],
    });
    expect(ctx.render.startDeployment.mock.calls[0][0]).not.toHaveProperty("githubToken");
    expect(ctx.github.getInstallationToken).not.toHaveBeenCalled();
    expect(ctx.vercel.startDeployment).not.toHaveBeenCalled();
  });

  it("asks for a Render account with Render's own error code", async () => {
    ctx.components.set("c1", { ...component, kind: "backend", provider: "render" });
    ctx.render.getCredential.mockResolvedValueOnce({ state: "invalid" });
    await expect(ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" })).rejects.toMatchObject({
      status: 412,
      code: "render_key_invalid",
    });
  });

  it("cancels through the provider's own service", async () => {
    ctx.components.set("c1", { ...component, kind: "backend", provider: "render" });
    const deployment = await ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" });
    await expect(ctx.service.cancel(deployment!)).resolves.toEqual({ status: "cancelling" });
    expect(ctx.render.cancelDeployment).toHaveBeenCalledWith(deployment!.id);
    expect(ctx.vercel.cancelDeployment).not.toHaveBeenCalled();
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
    // Phase 12: a pulled line keeps its time and stream, filed under the provider.
    expect(ctx.sink.write).toHaveBeenCalledWith("p1", id, [
      { text: "compiled", at: 1, stream: "stdout", source: "vercel", phase: "build" },
    ]);

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
    ctx.sink.write.mockClear(); // the deploy itself wrote its "Environment: …" line
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

  it("refuses a batch from another provider's service", async () => {
    await expect(
      ctx.service.applyBatch({ deploymentId: id, seq: 1, events: [{ type: "terminal", status: "failed" }] }, "render"),
    ).rejects.toMatchObject({ status: 403, code: "wrong_provider" });
    expect(ctx.deployments.get(id)).toMatchObject({ status: "queued" });
    await expect(ctx.service.applyBatch({ deploymentId: id, seq: 1, events: [] }, "vercel")).resolves.toEqual({
      applied: true,
    });
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

// ------------------------------------------------------------ Phase 8: Neon --

const database = {
  ...component,
  id: "db1",
  kind: "database",
  name: "database",
  rootDir: ".",
  framework: "postgres",
  provider: "neon",
};
const backend = {
  ...component,
  id: "be1",
  kind: "backend",
  name: "api",
  rootDir: "backend",
  framework: "express",
  startCmd: "npm start",
  provider: "render",
};

/** Every string that reached the log sink. */
const logged = (sink: ReturnType<typeof setup>["sink"]) => JSON.stringify([...sink.write.mock.calls, ...sink.section.mock.calls]);

describe("provisionDatabase (deploying a Neon database component)", () => {
  it("records a neon deployment, provisions, then marks it and the component live", async () => {
    const ctx = setup();
    ctx.components.set("db1", { ...database });
    const finished = vi.fn();
    ctx.service.onDeploymentFinished(finished);

    const started = await ctx.service.deployComponent("u1", "p1", "db1", { trigger: "manual", releaseId: "rel1" });
    expect(started).toMatchObject({ provider: "neon", status: "running", releaseId: "rel1", componentId: "db1" });
    await vi.waitFor(() => expect(ctx.deployments.get(started!.id)).toMatchObject({ status: "success" }));

    expect(ctx.neon.ensureDatabase).toHaveBeenCalledWith({ userId: "u1", componentId: "db1", projectName: "shop", componentName: "database" });
    expect(ctx.components.get("db1")).toMatchObject({
      status: "live",
      providerResourceId: "young-sun-1",
      url: "https://console.neon.tech/app/projects/young-sun-1",
    });
    expect(logged(ctx.sink)).toContain("Created Neon project shop-database");
    await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(expect.objectContaining({ id: started!.id, status: "success" })));
  });

  it("needs a Neon account before creating anything", async () => {
    const ctx = setup();
    ctx.components.set("db1", { ...database });
    ctx.neon.getCredential.mockResolvedValueOnce({ state: "missing" });
    await expect(ctx.service.deployComponent("u1", "p1", "db1", { trigger: "manual" })).rejects.toMatchObject({
      status: 412,
      code: "neon_not_connected",
    });
    expect(ctx.prisma.deployment.create).not.toHaveBeenCalled();
  });

  it("marks the row and the component failed when Neon fails", async () => {
    const ctx = setup();
    ctx.components.set("db1", { ...database });
    ctx.neon.ensureDatabase.mockRejectedValueOnce(new HttpError("Neon plan limit is reached.", 409, "neon_project_limit"));
    const started = await ctx.service.deployComponent("u1", "p1", "db1", { trigger: "manual" });
    await vi.waitFor(() =>
      expect(ctx.deployments.get(started!.id)).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("plan limit") }),
    );
    expect(ctx.components.get("db1")).toMatchObject({ status: "failed" });
  });
});

describe("Render backends get the Neon database env vars", () => {
  it("sends DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED (direct), over the project's own, and never logs them", async () => {
    const ctx = setup();
    ctx.components.set("db1", { ...database, providerResourceId: "young-sun-1", status: "live" });
    ctx.components.set("be1", { ...backend });
    ctx.envVars.resolve.mockResolvedValueOnce({
      vars: [
        { key: "DATABASE_URL", value: "postgres://old", secret: true },
        { key: "GREETING", value: "hi", secret: false },
      ],
      secrets: ["postgres://old"],
      revision: 1,
    });

    await ctx.service.deployComponent("u1", "p1", "be1", { trigger: "manual" });

    const request = ctx.render.startDeployment.mock.calls[0][0] as { envVars: Array<{ key: string; value: string }> };
    expect(request.envVars).toEqual([
      { key: "GREETING", value: "hi" },
      { key: "DATABASE_URL", value: POOLED },
      { key: "DATABASE_URL_UNPOOLED", value: DIRECT },
    ]);
    expect(ctx.neon.ensureDatabase).not.toHaveBeenCalled();
    const log = logged(ctx.sink);
    expect(log).toContain("come from the Neon database database");
    expect(log).toContain("The project's own DATABASE_URL is not used.");
    expect(log).not.toContain("npg_SECRETpw");
    expect(log).not.toContain("postgres://old");
  });

  it("provisions a database that is not provisioned yet, first", async () => {
    const ctx = setup();
    ctx.components.set("db1", { ...database });
    ctx.components.set("be1", { ...backend });

    const deployment = await ctx.service.deployComponent("u1", "p1", "be1", { trigger: "manual" });

    expect(ctx.neon.ensureDatabase).toHaveBeenCalledTimes(1);
    expect(ctx.render.startDeployment).toHaveBeenCalledTimes(1);
    const rows = [...ctx.deployments.values()];
    expect(rows.map((r) => r.provider).sort()).toEqual(["neon", "render"]);
    expect(rows.find((r) => r.provider === "neon")).toMatchObject({ status: "success" });
    expect(deployment).toMatchObject({ provider: "render" });
  });

  it("fails the backend deploy, with the Neon reason, when the database cannot be provisioned", async () => {
    const ctx = setup();
    ctx.components.set("db1", { ...database });
    ctx.components.set("be1", { ...backend });
    ctx.neon.ensureDatabase.mockRejectedValueOnce(new HttpError("Neon is down.", 502, "neon_unavailable"));

    await expect(ctx.service.deployComponent("u1", "p1", "be1", { trigger: "manual" })).rejects.toMatchObject({
      code: "neon_provision_failed",
    });
    expect(ctx.render.startDeployment).not.toHaveBeenCalled();
    const renderRow = [...ctx.deployments.values()].find((r) => r.provider === "render");
    expect(renderRow).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("Neon is down") });
  });

  it("sends only the project env vars when there is no database", async () => {
    const ctx = setup();
    ctx.components.set("be1", { ...backend });
    await ctx.service.deployComponent("u1", "p1", "be1", { trigger: "manual" });
    expect(ctx.neon.getConnection).not.toHaveBeenCalled();
    expect((ctx.render.startDeployment.mock.calls[0][0] as { envVars: unknown }).envVars).toEqual([{ key: "GREETING", value: "hi" }]);
  });
});

describe("Vercel frontends get the backend URL", () => {
  it("sends NEXT_PUBLIC_API_URL when there is exactly one backend with a URL", async () => {
    const ctx = setup();
    ctx.components.set("be1", { ...backend, url: "https://shop-api.onrender.com" });
    await ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" });
    expect(ctx.vercel.startDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ publicEnvVars: [{ key: "NEXT_PUBLIC_API_URL", value: "https://shop-api.onrender.com" }] }),
    );
  });

  it("leaves the project env alone while the backend has no URL, and clears it when there is no backend", async () => {
    const ctx = setup();
    ctx.components.set("be1", { ...backend, url: null });
    await ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" });
    expect(ctx.vercel.startDeployment.mock.calls[0][0]).not.toHaveProperty("publicEnvVars");
    expect(logged(ctx.sink)).toContain("has no URL yet");

    const none = setup();
    await none.service.deployComponent("u1", "p1", "c1", { trigger: "manual" });
    expect(none.vercel.startDeployment).toHaveBeenCalledWith(expect.objectContaining({ publicEnvVars: [] }));
  });
});

describe("finished deployments and reconcile", () => {
  it("tells the listener about a terminal event and about a deploy that failed to start", async () => {
    const ctx = setup();
    const finished = vi.fn();
    ctx.service.onDeploymentFinished(finished);
    const id = (await ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual", releaseId: "rel1" }))!.id;
    await ctx.service.applyBatch({ deploymentId: id, seq: 1, events: [{ type: "terminal", status: "live" }] });
    await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(expect.objectContaining({ id, status: "success", releaseId: "rel1" })));

    ctx.vercel.startDeployment.mockRejectedValueOnce(new HttpError("down", 503));
    await expect(ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" })).rejects.toThrow();
    await vi.waitFor(() => expect(finished).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" })));
  });

  it("closes a neon provisioning left running by a restart: success if Neon finished it, else failed", async () => {
    const ctx = setup();
    ctx.components.set("db1", { ...database, status: "deploying" });
    ctx.deployments.set("n1", { id: "n1", projectId: "p1", componentId: "db1", provider: "neon", status: "running" });
    ctx.deployments.set("n2", { id: "n2", projectId: "p1", componentId: "db1", provider: "neon", status: "running" });
    ctx.neon.getDatabase
      .mockResolvedValueOnce({ state: "ready", neonProjectId: "young-sun-1", consoleUrl: "https://console.neon.tech/app/projects/young-sun-1" })
      .mockResolvedValueOnce({ state: "provisioning", neonProjectId: "young-sun-1", consoleUrl: "x" });

    await ctx.service.reconcile();

    expect(ctx.deployments.get("n1")).toMatchObject({ status: "success" });
    expect(ctx.deployments.get("n2")).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("interrupted") });
  });
});

describe("env vars (Phase 9)", () => {
  it("sends a Vercel frontend its own vars, records the env revision and registers the secrets for redaction", async () => {
    const ctx = setup();
    ctx.envVars.resolve.mockResolvedValueOnce({
      vars: [
        { key: "NEXT_PUBLIC_GREETING", value: "hello", secret: false },
        { key: "SERVER_ONLY_TOKEN", value: "tok_123456", secret: true },
      ],
      secrets: ["tok_123456"],
      revision: 7,
    });

    const deployment = await ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" });

    expect(ctx.vercel.startDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: [
          { key: "NEXT_PUBLIC_GREETING", value: "hello", secret: false },
          { key: "SERVER_ONLY_TOKEN", value: "tok_123456", secret: true },
        ],
      }),
    );
    expect(ctx.deployments.get(deployment!.id)).toMatchObject({ envRevision: 7 });
    expect(ctx.sink.addSecrets).toHaveBeenCalledWith("p1", deployment!.id, ["tok_123456"]);
    const log = logged(ctx.sink);
    expect(log).toContain("SERVER_ONLY_TOKEN (secret)");
    expect(log).not.toContain("tok_123456");
  });

  it("lets the frontend's own API URL win over the backend's", async () => {
    const ctx = setup();
    ctx.components.set("be1", { ...backend, url: "https://shop-api.onrender.com" });
    ctx.envVars.resolve.mockResolvedValueOnce({
      vars: [{ key: "NEXT_PUBLIC_API_URL", value: "https://api.example.com", secret: false }],
      secrets: [],
      revision: 1,
    });

    await ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" });

    expect(ctx.vercel.startDeployment).toHaveBeenCalledWith(expect.objectContaining({ publicEnvVars: [] }));
    expect(logged(ctx.sink)).toContain("NEXT_PUBLIC_API_URL comes from web's own env vars");
  });

  it("registers both Neon connection strings for redaction on a Render deploy", async () => {
    const ctx = setup();
    ctx.components.set("db1", { ...database, providerResourceId: "young-sun-1", status: "live" });
    ctx.components.set("be1", { ...backend });

    const deployment = await ctx.service.deployComponent("u1", "p1", "be1", { trigger: "manual" });

    expect(ctx.envVars.resolve).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "be1", kind: "backend" }));
    expect(ctx.sink.addSecrets).toHaveBeenCalledWith("p1", deployment!.id, [POOLED, DIRECT]);
  });
});

describe("log line tags (Phase 12)", () => {
  it("files the integration service's own lines as orbitops and the provider's under the provider", async () => {
    const ctx = setup();
    const deployment = await ctx.service.deployComponent("u1", "p1", "c1", { trigger: "manual" });
    ctx.sink.write.mockClear();
    await ctx.service.applyBatch({
      deploymentId: deployment!.id,
      seq: 1,
      events: [
        {
          type: "logs",
          lines: [
            { at: 5, stream: "info", text: "==> Preparing Vercel project", origin: "orbitops", phase: "deploy" },
            { at: 6, stream: "stderr", text: "warn: big bundle", origin: "provider", phase: "build" },
            { at: 7, stream: "stdout", text: "old service, untagged" },
          ],
        },
      ],
    });
    expect(ctx.sink.write).toHaveBeenCalledWith("p1", deployment!.id, [
      { text: "==> Preparing Vercel project", at: 5, stream: "info", source: "orbitops", phase: "deploy" },
      { text: "warn: big bundle", at: 6, stream: "stderr", source: "vercel", phase: "build" },
      { text: "old service, untagged", at: 7, stream: "stdout", source: "vercel", phase: "build" },
    ]);
  });
});
