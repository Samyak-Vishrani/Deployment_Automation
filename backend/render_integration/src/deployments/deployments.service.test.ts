import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "../test-support/fake-db";
import type { DeployRequest } from "../types";
import { DeploymentsService } from "./deployments.service";
import { EnvVault } from "./env-vault";

const request: DeployRequest = {
  deploymentId: "dep1",
  userId: "u1",
  component: {
    id: "comp1",
    name: "api",
    rootDir: "backend",
    framework: "express",
    installCmd: null,
    buildCmd: null,
    startCmd: "npm start",
    nodeVersion: null,
    healthCheckPath: null,
  },
  repo: { fullName: "me/shop", branch: "main" },
  commitSha: "c".repeat(40),
  envVars: [{ key: "API_SECRET", value: "do-not-store-me" }],
};

function setup() {
  const db = fakeDb();
  const queue = { add: vi.fn(() => true), cancel: vi.fn(() => "not-found" as "aborted" | "removed" | "not-found") };
  const vault = new EnvVault();
  const outbox = { push: vi.fn(), drain: vi.fn(async () => undefined) };
  const credentials = {
    getKey: vi.fn(async () => ({ apiKey: "k", ownerId: "o", region: "oregon", plan: "free" })),
    markInvalid: vi.fn(async () => undefined),
  };
  const provider = { cancel: vi.fn(async () => undefined), setEnv: vi.fn(), destroy: vi.fn(), rollback: vi.fn() };
  const service = new DeploymentsService(db, queue, vault, outbox, credentials, provider);
  return { db, queue, vault, outbox, credentials, provider, service };
}

describe("DeploymentsService", () => {
  it("stores the env keys but never the values, keeps the values in memory and queues the job", async () => {
    const ctx = setup();
    const view = await ctx.service.start(request);

    expect(view).toMatchObject({ deploymentId: "dep1", state: "queued" });
    const stored = JSON.stringify(ctx.db.renderDeployment.rows[0]);
    expect(stored).not.toContain("do-not-store-me");
    expect((ctx.db.renderDeployment.rows[0].input as { envKeys: string[] }).envKeys).toEqual(["API_SECRET"]);
    expect(ctx.vault.take("dep1")).toEqual([{ key: "API_SECRET", value: "do-not-store-me" }]);
    expect(ctx.queue.add).toHaveBeenCalledWith({ deploymentId: "dep1", componentId: "comp1" });
  });

  it("is idempotent on the deployment id", async () => {
    const ctx = setup();
    await ctx.service.start(request);
    await ctx.service.start(request);
    expect(ctx.db.renderDeployment.rows).toHaveLength(1);
    expect(ctx.queue.add).toHaveBeenCalledTimes(1);
  });

  it("refuses before queuing when there is no usable key", async () => {
    const ctx = setup();
    ctx.credentials.getKey.mockRejectedValueOnce(Object.assign(new Error("Connect Render"), { code: "render_not_connected" }));
    await expect(ctx.service.start(request)).rejects.toThrow(/Connect Render/);
    expect(ctx.db.renderDeployment.rows).toHaveLength(0);
  });

  it("on restart resumes deploys Render has and fails the ones that never reached it", async () => {
    const ctx = setup();
    await ctx.db.renderDeployment.create({ data: { deploymentId: "a", userId: "u1", componentId: "c1", input: {}, state: "building", renderDeployId: "dep-a" } });
    await ctx.db.renderDeployment.create({ data: { deploymentId: "b", userId: "u1", componentId: "c2", input: {}, state: "deploying" } });
    await ctx.db.renderDeployment.create({ data: { deploymentId: "c", userId: "u1", componentId: "c3", input: {}, state: "live" } });

    await expect(ctx.service.resumeAll()).resolves.toEqual({ resumed: 1, failed: 1 });
    expect(ctx.queue.add).toHaveBeenCalledWith({ deploymentId: "a", componentId: "c1" });
    expect(ctx.db.renderDeployment.rows.find((r) => r.deploymentId === "b")).toMatchObject({ state: "failed" });
    expect(ctx.outbox.push).toHaveBeenCalledWith("b", expect.objectContaining({ type: "terminal", status: "failed" }));
  });

  it("cancels on Render a deploy that is not running in this process", async () => {
    const ctx = setup();
    await ctx.db.renderService.create({
      data: { componentId: "c1", userId: "u1", renderServiceId: "srv-1", name: "x", ownerId: "o", region: "oregon", plan: "free", runtime: "node", settingsHash: "h" },
    });
    await ctx.db.renderDeployment.create({ data: { deploymentId: "a", userId: "u1", componentId: "c1", input: {}, state: "building", renderDeployId: "dep-a" } });

    await expect(ctx.service.cancel("a")).resolves.toMatchObject({ state: "cancelled" });
    expect(ctx.provider.cancel).toHaveBeenCalledWith({ apiKey: "k" }, "srv-1", "dep-a");
  });
});
