import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@orbitops/integration-common/provider-error";
import { fakeDb, type FakeDb } from "../test-support/fake-db";
import { EnvVault } from "@orbitops/integration-common/env-vault";
import type { ProviderEvent, StoredDeployInput, UserEnvVar } from "../types";
import type { StatusResult } from "../vercel/vercel.provider";
import { DeployRunner } from "./deploy-runner";

const TOKEN = "vercel_token_should_never_appear";

const input: StoredDeployInput = {
  deploymentId: "dep1",
  userId: "u1",
  component: {
    id: "comp1",
    name: "web",
    rootDir: "frontend",
    framework: "nextjs",
    installCmd: null,
    buildCmd: null,
    outputDir: null,
    nodeVersion: null,
  },
  repo: { fullName: "me/shop", repoId: 42, branch: "main" },
  commitSha: "b".repeat(40),
};

function status(s: StatusResult["status"], extra: Partial<StatusResult> = {}): StatusResult {
  return { status: s, url: "https://shop-web-1.vercel.app", productionUrl: null, inspectorUrl: null, errorMessage: null, ...extra };
}

function setup(
  options: { statuses?: StatusResult[]; vercelDeploymentId?: string; input?: StoredDeployInput; userEnv?: UserEnvVar[] } = {},
) {
  const db: FakeDb = fakeDb();
  const events: ProviderEvent[] = [];
  const statuses = [...(options.statuses ?? [status("building"), status("live", { productionUrl: "https://shop-web.vercel.app" })])];

  const provider = {
    ensureProject: vi.fn(async () => ({
      vercelProjectId: "prj_1",
      name: "shop-web",
      gitLinked: true,
      settingsHash: "h",
      created: true,
      updated: false,
    })),
    syncPublicEnv: vi.fn(async () => undefined),
    syncUserEnv: vi.fn(async () => undefined),
    deploy: vi.fn(async () => ({
      providerDeploymentId: "dpl_1",
      url: "https://shop-web-1.vercel.app",
      inspectorUrl: "https://vercel.com/inspect/1",
      sourceMode: "git" as const,
      readyState: "queued" as const,
    })),
    getStatus: vi.fn(async () => statuses.shift() ?? status("building")),
    getLogs: vi.fn(async () => [
      { id: "e1", at: 10, stream: "stdout" as const, text: `building with ${TOKEN}` },
      { id: "e2", at: 11, stream: "stdout" as const, text: "done" },
    ]),
    cancel: vi.fn(async () => undefined),
  };
  const credentials = {
    getToken: vi.fn(async () => ({ token: TOKEN, teamId: "team_1" })),
    markInvalid: vi.fn(async () => undefined),
  };
  const outbox = {
    push: vi.fn((_id: string, event: ProviderEvent) => {
      events.push(structuredClone(event));
    }),
    drain: vi.fn(async () => undefined),
  };
  const envVault = new EnvVault<UserEnvVar>();
  if (options.userEnv) envVault.put("dep1", options.userEnv);
  const runner = new DeployRunner(
    db,
    provider,
    credentials,
    outbox,
    { take: () => "ghs_installation_token_1234567890" },
    { pollIntervalMs: 1, deployTimeoutMs: 60_000, workRoot: "unused", sleep: async () => undefined },
    envVault,
  );

  const seed = () =>
    db.vercelDeployment.create({
      data: {
        deploymentId: "dep1",
        userId: "u1",
        componentId: "comp1",
        input: options.input ?? input,
        state: options.vercelDeploymentId ? "building" : "queued",
        vercelDeploymentId: options.vercelDeploymentId ?? null,
      },
    });

  return { db, events, provider, credentials, runner, seed, envVault };
}

const run = (runner: DeployRunner, signal = new AbortController().signal) =>
  runner.run({ deploymentId: "dep1", componentId: "comp1" }, signal);

describe("DeployRunner", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await ctx.seed();
  });

  it("creates the project, deploys, polls to live and reports every step in order", async () => {
    await run(ctx.runner);

    const types = ctx.events.map((e) => (e.type === "status" ? `status:${e.providerStatus}` : e.type));
    expect(types.filter((t) => t !== "logs")).toEqual([
      "status:deploying",
      "resource",
      "deployment",
      "status:building",
      "status:live",
      "terminal",
    ]);
    expect(ctx.events.find((e) => e.type === "terminal")).toMatchObject({
      status: "live",
      productionUrl: "https://shop-web.vercel.app",
    });

    const row = ctx.db.vercelDeployment.rows[0];
    expect(row).toMatchObject({ state: "live", vercelDeploymentId: "dpl_1", sourceMode: "git", lastEventAt: 11 });
    expect(ctx.db.vercelProject.rows[0]).toMatchObject({ componentId: "comp1", vercelProjectId: "prj_1", teamId: "team_1" });
  });

  it("stores the Vercel project before deploying, so a crash mid-deploy cannot create a second one", async () => {
    ctx.provider.deploy.mockImplementationOnce(async () => {
      expect(ctx.db.vercelProject.rows).toHaveLength(1);
      throw new ProviderError("boom", 502, "vercel_unavailable");
    });
    await run(ctx.runner);
    expect(ctx.db.vercelDeployment.rows[0].state).toBe("failed");
  });

  it("relays each log line once and never relays the token", async () => {
    await run(ctx.runner);
    const lines = ctx.events.flatMap((e) => (e.type === "logs" ? e.lines.map((l) => l.text) : []));
    expect(lines.filter((l) => l === "done")).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).toContain("***REDACTED***");
  });

  it("tags each relayed line: our own as orbitops, Vercel's as provider build output (Phase 12)", async () => {
    await run(ctx.runner);
    const lines = ctx.events.flatMap((e) => (e.type === "logs" ? e.lines : []));
    expect(lines.find((l) => l.text.startsWith("==> Preparing"))).toMatchObject({ origin: "orbitops", phase: "deploy" });
    expect(lines.find((l) => l.text === "done")).toMatchObject({ origin: "provider", phase: "build" });
  });

  it("reports a failed build with Vercel's message", async () => {
    ctx = setup({ statuses: [status("failed", { errorMessage: "Command \"npm run build\" exited with 1" })] });
    await ctx.seed();
    await run(ctx.runner);
    expect(ctx.events.find((e) => e.type === "terminal")).toMatchObject({
      status: "failed",
      errorMessage: 'Vercel build failed: Command "npm run build" exited with 1',
    });
  });

  it("resumes polling a deploy Vercel already has, without creating or deploying again", async () => {
    ctx = setup({ vercelDeploymentId: "dpl_old" });
    await ctx.seed();
    await run(ctx.runner);
    expect(ctx.provider.ensureProject).not.toHaveBeenCalled();
    expect(ctx.provider.deploy).not.toHaveBeenCalled();
    expect(ctx.provider.getStatus).toHaveBeenCalledWith(expect.anything(), "dpl_old", expect.any(String));
    expect(ctx.db.vercelDeployment.rows[0].state).toBe("live");
  });

  it("cancels on Vercel when the user cancels", async () => {
    const controller = new AbortController();
    ctx.provider.getStatus.mockImplementation(async () => {
      controller.abort("cancel");
      throw new Error("aborted");
    });
    await run(ctx.runner, controller.signal);
    expect(ctx.provider.cancel).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }), "dpl_1");
    expect(ctx.db.vercelDeployment.rows[0].state).toBe("cancelled");
  });

  it("leaves the deploy running on Vercel when the service shuts down", async () => {
    const controller = new AbortController();
    ctx.provider.getStatus.mockImplementation(async () => {
      controller.abort("shutdown");
      throw new Error("aborted");
    });
    await run(ctx.runner, controller.signal);
    expect(ctx.provider.cancel).not.toHaveBeenCalled();
    expect(ctx.db.vercelDeployment.rows[0].state).not.toBe("cancelled");
    expect(ctx.events.some((e) => e.type === "terminal")).toBe(false);
  });

  it("marks the credential invalid when Vercel rejects the token", async () => {
    ctx.provider.ensureProject.mockRejectedValueOnce(
      new ProviderError("Vercel rejected the saved token.", 412, "vercel_token_invalid", { invalidToken: true }),
    );
    await run(ctx.runner);
    expect(ctx.credentials.markInvalid).toHaveBeenCalledWith("u1");
    expect(ctx.db.vercelDeployment.rows[0].state).toBe("failed");
  });

  it("fails after the deadline", async () => {
    ctx = setup({ statuses: [] });
    await ctx.seed();
    ctx.db.vercelDeployment.rows[0].createdAt = new Date(Date.now() - 120_000);
    await run(ctx.runner);
    expect(ctx.events.find((e) => e.type === "terminal")).toMatchObject({ status: "failed" });
    expect(String(ctx.db.vercelDeployment.rows[0].errorMessage)).toMatch(/did not finish within/);
  });
});

describe("DeployRunner: public env vars (Phase 8)", () => {
  const withApi = (value: string): StoredDeployInput => ({
    ...input,
    publicEnvVars: [{ key: "NEXT_PUBLIC_API_URL", value }],
  });

  it("sets them on the project before deploying, and records what it manages", async () => {
    const ctx = setup({ input: withApi("https://shop-api.onrender.com") });
    await ctx.seed();
    let deployedAfterSync = false;
    ctx.provider.deploy.mockImplementationOnce(async () => {
      deployedAfterSync = ctx.provider.syncPublicEnv.mock.calls.length === 1;
      return {
        providerDeploymentId: "dpl_1",
        url: "https://shop-web-1.vercel.app",
        inspectorUrl: null,
        sourceMode: "git" as const,
        readyState: "queued" as const,
      } as never;
    });
    await run(ctx.runner);

    expect(deployedAfterSync).toBe(true);
    expect(ctx.provider.syncPublicEnv).toHaveBeenCalledWith(
      expect.anything(),
      "prj_1",
      [{ key: "NEXT_PUBLIC_API_URL", value: "https://shop-api.onrender.com" }],
      [],
    );
    expect(ctx.db.vercelProject.rows[0]).toMatchObject({ managedEnvKeys: ["NEXT_PUBLIC_API_URL"] });
    expect(ctx.events.some((e) => e.type === "logs" && e.lines.some((l) => l.text.includes("Set NEXT_PUBLIC_API_URL")))).toBe(true);
  });

  it("skips the env calls when nothing changed, and removes keys no longer sent", async () => {
    const first = setup({ input: withApi("https://shop-api.onrender.com") });
    await first.seed();
    await run(first.runner);
    const project = structuredClone(first.db.vercelProject.rows[0]);

    // Same value again: no call.
    const again = setup({ input: withApi("https://shop-api.onrender.com") });
    again.db.vercelProject.rows.push(structuredClone(project));
    await again.seed();
    await run(again.runner);
    expect(again.provider.syncPublicEnv).not.toHaveBeenCalled();

    // Nothing sent any more ([]): the managed key is removed.
    const gone = setup({ input: { ...input, publicEnvVars: [] } });
    gone.db.vercelProject.rows.push(structuredClone(project));
    await gone.seed();
    await run(gone.runner);
    expect(gone.provider.syncPublicEnv).toHaveBeenCalledWith(expect.anything(), "prj_1", [], ["NEXT_PUBLIC_API_URL"]);
    expect(gone.db.vercelProject.rows[0].managedEnvKeys).toEqual([]);
  });

  it("leaves the project's env alone when the request carries none (older backends)", async () => {
    const ctx = setup();
    await ctx.seed();
    await run(ctx.runner);
    expect(ctx.provider.syncPublicEnv).not.toHaveBeenCalled();
  });
});

describe("DeployRunner: the user's env vars (Phase 9)", () => {
  const SECRET_VALUE = "sk_live_should_never_appear_anywhere";
  const userEnv: UserEnvVar[] = [
    { key: "NEXT_PUBLIC_GREETING", value: "hello", secret: false },
    { key: "SERVER_ONLY_TOKEN", value: SECRET_VALUE, secret: true },
  ];
  const withKeys = { ...input, envKeys: userEnv.map((v) => v.key) };

  it("sets them before deploying, logs keys only and scrubs every value from the relayed build log", async () => {
    const ctx = setup({ input: withKeys, userEnv });
    ctx.provider.getLogs.mockResolvedValueOnce([{ id: "e1", at: 10, stream: "stdout" as const, text: `token is ${SECRET_VALUE}` }]);
    ctx.provider.deploy.mockImplementationOnce(async () => {
      expect(ctx.provider.syncUserEnv).toHaveBeenCalledTimes(1);
      return { providerDeploymentId: "dpl_1", url: "u", inspectorUrl: "https://vercel.com/i", sourceMode: "git" as const, readyState: "queued" as const };
    });
    await ctx.seed();
    await run(ctx.runner);

    expect(ctx.provider.syncUserEnv).toHaveBeenCalledWith(expect.anything(), "prj_1", userEnv, [], []);
    expect(ctx.db.vercelProject.rows[0].managedUserEnvKeys).toEqual([
      { key: "NEXT_PUBLIC_GREETING", secret: false },
      { key: "SERVER_ONLY_TOKEN", secret: true },
    ]);
    const all = JSON.stringify(ctx.events) + JSON.stringify(ctx.db.vercelDeployment.rows) + JSON.stringify(ctx.db.vercelProject.rows);
    expect(all).not.toContain(SECRET_VALUE);
    expect(all).toContain("SERVER_ONLY_TOKEN (secret)");
    expect(ctx.db.vercelDeployment.rows[0].state).toBe("live");
  });

  it("skips an unchanged set, deletes keys no longer sent and re-creates a flipped secret", async () => {
    const first = setup({ input: withKeys, userEnv });
    await first.seed();
    await run(first.runner);
    const project = first.db.vercelProject.rows[0];

    // Same set again: no env call.
    const again = setup({ input: withKeys, userEnv });
    again.db.vercelProject.rows.push({ ...project });
    await again.seed();
    await run(again.runner);
    expect(again.provider.syncUserEnv).not.toHaveBeenCalled();

    // GREETING becomes a secret, the token is gone.
    const next: UserEnvVar[] = [{ key: "NEXT_PUBLIC_GREETING", value: "hello", secret: true }];
    const changed = setup({ input: { ...input, envKeys: ["NEXT_PUBLIC_GREETING"] }, userEnv: next });
    changed.db.vercelProject.rows.push({ ...project });
    await changed.seed();
    await run(changed.runner);
    expect(changed.provider.syncUserEnv).toHaveBeenCalledWith(expect.anything(), "prj_1", next, ["SERVER_ONLY_TOKEN"], ["NEXT_PUBLIC_GREETING"]);
  });

  it("fails with vercel_interrupted when the values were lost, and leaves user vars alone when none were sent", async () => {
    const lost = setup({ input: withKeys });
    await lost.seed();
    await run(lost.runner);
    expect(lost.provider.deploy).not.toHaveBeenCalled();
    expect(lost.db.vercelDeployment.rows[0]).toMatchObject({ state: "failed", errorMessage: expect.stringContaining("Deploy again") });

    const empty = setup({ input: { ...input, envKeys: [] } });
    await empty.seed();
    await run(empty.runner);
    expect(empty.provider.syncUserEnv).toHaveBeenCalledWith(expect.anything(), "prj_1", [], [], []);
    expect(empty.db.vercelDeployment.rows[0].state).toBe("live");

    const legacy = setup();
    await legacy.seed();
    await run(legacy.runner);
    expect(legacy.provider.syncUserEnv).not.toHaveBeenCalled();
  });
});
