import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../http/provider-error";
import { fakeDb, type FakeDb } from "../test-support/fake-db";
import type { EnvVar, ProviderEvent, StoredDeployInput } from "../types";
import type { StatusResult } from "../render/render.provider";
import { DeployRunner } from "./deploy-runner";

const KEY = "rnd_key_should_never_appear";
const ENV_SECRET = "super-secret-env-value";

const input: StoredDeployInput = {
  deploymentId: "dep1",
  userId: "u1",
  component: {
    id: "comp1",
    name: "api",
    rootDir: "backend",
    framework: "express",
    installCmd: "npm install",
    buildCmd: null,
    startCmd: "npm start",
    nodeVersion: "20",
    healthCheckPath: "/health",
  },
  repo: { fullName: "me/shop", branch: "main" },
  commitSha: "b".repeat(40),
  envKeys: ["API_SECRET"],
};

const status = (s: StatusResult["status"], rawStatus = s as string): StatusResult => ({ status: s, rawStatus });

function setup(options: { statuses?: StatusResult[]; renderDeployId?: string; env?: EnvVar[] | undefined } = {}) {
  const db: FakeDb = fakeDb();
  const events: ProviderEvent[] = [];
  const statuses = [...(options.statuses ?? [status("building", "build_in_progress"), status("deploying", "update_in_progress"), status("live")])];
  const env = "env" in options ? options.env : [{ key: "API_SECRET", value: ENV_SECRET }];

  const provider = {
    ensureService: vi.fn(async () => ({
      renderServiceId: "srv-1",
      name: "shop-api",
      ownerId: "own_1",
      region: "oregon",
      plan: "free",
      runtime: "node",
      url: "https://shop-api.onrender.com",
      dashboardUrl: "https://dashboard.render.com/web/srv-1",
      settingsHash: "h",
      envHash: "e",
      managedEnvKeys: ["API_SECRET", "NODE_VERSION"],
      created: true,
      initialDeployId: "dep-0",
    })),
    deploy: vi.fn(async () => ({
      providerDeploymentId: "dep-1",
      status: "queued" as const,
      dashboardUrl: "https://dashboard.render.com/web/srv-1/deploys/dep-1",
      adopted: false,
    })),
    getStatus: vi.fn(async () => statuses.shift() ?? status("building", "build_in_progress")),
    getLogs: vi.fn(async () => ({
      lines: [
        { id: "l1", at: 10, stream: "stdout" as const, text: `npm install (key ${KEY}, value ${ENV_SECRET})` },
        { id: "l2", at: 11, stream: "stdout" as const, text: "server listening" },
      ],
      cursor: "2026-11-03T10:00:11.000Z" as string | null,
    })),
    cancel: vi.fn(async () => undefined),
    getServiceUrl: vi.fn(async () => "https://shop-api.onrender.com"),
    probeHealth: vi.fn(async () => true),
  };
  const credentials = {
    getKey: vi.fn(async () => ({ apiKey: KEY, ownerId: "own_1", region: "oregon", plan: "free" })),
    markInvalid: vi.fn(async () => undefined),
  };
  const outbox = {
    push: vi.fn((_id: string, event: ProviderEvent) => {
      events.push(structuredClone(event));
    }),
    drain: vi.fn(async () => undefined),
  };
  const runner = new DeployRunner(db, provider, credentials, outbox, { take: () => env }, {
    pollIntervalMs: 1,
    deployTimeoutMs: 60_000,
    sleep: async () => undefined,
    healthAttempts: 1,
  });

  const seed = async () => {
    await db.renderDeployment.create({
      data: {
        deploymentId: "dep1",
        userId: "u1",
        componentId: "comp1",
        input,
        state: options.renderDeployId ? "building" : "queued",
        renderDeployId: options.renderDeployId ?? null,
      },
    });
    if (options.renderDeployId) {
      await db.renderService.create({
        data: {
          componentId: "comp1",
          userId: "u1",
          renderServiceId: "srv-1",
          name: "shop-api",
          ownerId: "own_1",
          region: "oregon",
          plan: "free",
          runtime: "node",
          url: "https://shop-api.onrender.com",
          settingsHash: "h",
        },
      });
    }
  };
  return { db, events, provider, credentials, runner, seed };
}

const run = (runner: DeployRunner, signal = new AbortController().signal) =>
  runner.run({ deploymentId: "dep1", componentId: "comp1" }, signal);

const kinds = (events: ProviderEvent[]) =>
  events.filter((e) => e.type !== "logs").map((e) => (e.type === "status" ? `status:${e.providerStatus}` : e.type));

describe("DeployRunner", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await ctx.seed();
  });

  it("ensures the service, deploys the exact commit, polls to live and reports every step in order", async () => {
    await run(ctx.runner);

    expect(kinds(ctx.events)).toEqual([
      "status:deploying",
      "resource",
      "deployment",
      "status:building",
      "status:deploying",
      "status:live",
      "terminal",
    ]);
    expect(ctx.provider.deploy).toHaveBeenCalledWith(expect.anything(), "srv-1", input.commitSha, "dep-0", expect.any(Function));
    expect(ctx.events.find((e) => e.type === "deployment")).toMatchObject({
      providerDeploymentId: "dep-1",
      sourceMode: "git",
      inspectorUrl: "https://dashboard.render.com/web/srv-1/deploys/dep-1",
    });
    expect(ctx.events.find((e) => e.type === "terminal")).toMatchObject({
      status: "live",
      productionUrl: "https://shop-api.onrender.com",
    });
    expect(ctx.provider.probeHealth).toHaveBeenCalledWith("https://shop-api.onrender.com", "/health", expect.any(Function), expect.anything());
    expect(ctx.db.renderDeployment.rows[0]).toMatchObject({ state: "live", renderDeployId: "dep-1", lastLogAt: "2026-11-03T10:00:11.000Z" });
    expect(ctx.db.renderService.rows[0]).toMatchObject({ componentId: "comp1", renderServiceId: "srv-1", managedEnvKeys: ["API_SECRET", "NODE_VERSION"] });
  });

  it("passes the env vars to the service and the workspace defaults", async () => {
    await run(ctx.runner);
    expect(ctx.provider.ensureService).toHaveBeenCalledWith(
      expect.anything(),
      null,
      input.component,
      input.repo,
      { ownerId: "own_1", region: "oregon", plan: "free" },
      [{ key: "API_SECRET", value: ENV_SECRET }],
      expect.any(Function),
    );
  });

  it("never relays the API key or an env value, and relays each log line once", async () => {
    await run(ctx.runner);
    const text = ctx.events.flatMap((e) => (e.type === "logs" ? e.lines.map((l) => l.text) : [])).join("\n");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(ENV_SECRET);
    expect(text).toContain("***REDACTED***");
    expect(text.split("server listening")).toHaveLength(2);
  });

  it("stores the Render service before deploying, so a crash mid-deploy cannot create a second one", async () => {
    ctx.provider.deploy.mockImplementationOnce(async () => {
      expect(ctx.db.renderService.rows).toHaveLength(1);
      throw new ProviderError("boom", 502, "render_unavailable");
    });
    await run(ctx.runner);
    expect(ctx.db.renderDeployment.rows[0].state).toBe("failed");
  });

  it("explains a failed deploy from its log", async () => {
    ctx = setup({ statuses: [status("failed", "update_failed")] });
    await ctx.seed();
    ctx.provider.getLogs.mockResolvedValue({ lines: [{ id: "x", at: 1, stream: "stdout", text: "==> No open ports detected" }], cursor: null });
    await run(ctx.runner);
    const terminal = ctx.events.find((e) => e.type === "terminal") as { errorMessage: string };
    expect(terminal.errorMessage).toMatch(/did not start/);
    expect(terminal.errorMessage).toMatch(/process\.env\.PORT/);
  });

  it("resumes polling a deploy Render already has, without creating or deploying again", async () => {
    ctx = setup({ renderDeployId: "dep-old", env: undefined });
    await ctx.seed();
    await run(ctx.runner);
    expect(ctx.provider.ensureService).not.toHaveBeenCalled();
    expect(ctx.provider.deploy).not.toHaveBeenCalled();
    expect(ctx.provider.getStatus).toHaveBeenCalledWith(expect.anything(), "srv-1", "dep-old");
    expect(ctx.db.renderDeployment.rows[0].state).toBe("live");
  });

  it("fails a deploy that never reached Render once its env vars are gone", async () => {
    ctx = setup({ env: undefined });
    await ctx.seed();
    await run(ctx.runner);
    expect(ctx.provider.ensureService).not.toHaveBeenCalled();
    expect(String(ctx.db.renderDeployment.rows[0].errorMessage)).toMatch(/Deploy again/);
  });

  it("cancels on Render when the user cancels, but not on shutdown", async () => {
    const cancelled = new AbortController();
    ctx.provider.getStatus.mockImplementationOnce(async () => {
      cancelled.abort("cancel");
      throw new Error("aborted");
    });
    await run(ctx.runner, cancelled.signal);
    expect(ctx.provider.cancel).toHaveBeenCalledWith(expect.objectContaining({ apiKey: KEY }), "srv-1", "dep-1");
    expect(ctx.db.renderDeployment.rows[0].state).toBe("cancelled");

    const other = setup({ renderDeployId: "dep-x" });
    await other.seed();
    const shutdown = new AbortController();
    other.provider.getStatus.mockImplementationOnce(async () => {
      shutdown.abort("shutdown");
      throw new Error("aborted");
    });
    await run(other.runner, shutdown.signal);
    expect(other.provider.cancel).not.toHaveBeenCalled();
    expect(other.events.some((e) => e.type === "terminal")).toBe(false);
  });

  it("marks the credential invalid when Render rejects the key", async () => {
    ctx.provider.ensureService.mockRejectedValueOnce(
      new ProviderError("Render rejected the saved API key.", 412, "render_key_invalid", { invalidToken: true }),
    );
    await run(ctx.runner);
    expect(ctx.credentials.markInvalid).toHaveBeenCalledWith("u1");
  });

  it("fails after the deadline", async () => {
    ctx = setup({ statuses: [] });
    await ctx.seed();
    ctx.db.renderDeployment.rows[0].createdAt = new Date(Date.now() - 120_000);
    await run(ctx.runner);
    expect(String(ctx.db.renderDeployment.rows[0].errorMessage)).toMatch(/did not finish within/);
  });
});
