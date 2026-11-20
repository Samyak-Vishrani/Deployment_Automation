import { describe, expect, it, vi } from "vitest";
import { EnvVault } from "@orbitops/integration-common/env-vault";
import { fakeDb } from "../test-support/fake-db";
import type { DeployRequest, UserEnvVar } from "../types";
import { DeploymentsService } from "./deployments.service";

const request: DeployRequest = {
  deploymentId: "dep1",
  userId: "u1",
  component: { id: "comp1", name: "web", rootDir: "frontend", framework: "nextjs", installCmd: null, buildCmd: null, outputDir: null, nodeVersion: null },
  repo: { fullName: "me/shop", repoId: 42, branch: "main" },
  commitSha: "a".repeat(40),
  githubToken: "ghs_token_1234567890",
  envVars: [{ key: "SERVER_TOKEN", value: "never-stored-value", secret: true }],
};

function setup() {
  const db = fakeDb();
  const queue = { add: vi.fn(), cancel: vi.fn() };
  const tokens = { put: vi.fn() };
  const envVault = new EnvVault<UserEnvVar>();
  const service = new DeploymentsService(
    db,
    queue,
    tokens,
    { push: vi.fn(), drain: vi.fn(async () => undefined) },
    { getToken: vi.fn(async () => ({ token: "t", teamId: null })), markInvalid: vi.fn() },
    { cancel: vi.fn(), setEnv: vi.fn(), destroy: vi.fn() },
    envVault,
  );
  return { db, queue, tokens, envVault, service };
}

describe("DeploymentsService.start (Phase 9 env vars)", () => {
  it("stores which keys were sent, never their values, and hands the values to the vault", async () => {
    const ctx = setup();
    await ctx.service.start(request);

    const stored = JSON.stringify(ctx.db.vercelDeployment.rows[0]);
    expect(stored).not.toContain("never-stored-value");
    expect(stored).not.toContain("ghs_token_1234567890");
    expect(ctx.db.vercelDeployment.rows[0].input).toMatchObject({ envKeys: ["SERVER_TOKEN"] });
    expect(ctx.envVault.take("dep1")).toEqual(request.envVars);
    expect(ctx.queue.add).toHaveBeenCalledWith({ deploymentId: "dep1", componentId: "comp1" });
  });

  it("records no envKeys when the request carried no envVars (an older backend)", async () => {
    const ctx = setup();
    const { envVars: _omitted, ...legacy } = request;
    void _omitted;
    await ctx.service.start(legacy);
    expect(ctx.db.vercelDeployment.rows[0].input).not.toHaveProperty("envKeys");
    expect(ctx.envVault.take("dep1")).toBeUndefined();
  });
});
