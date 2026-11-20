import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AiService, parseAskBody } from "./ai.service";
import { AiContextBuilder, DOCKER_COMPONENT_ID } from "./context-builder";

const SECRET = "sk_live_super_secret_value_123";
const DB_URL = "postgres://owner:neonpassword987@ep-1.neon.tech/neondb";
const T = new Date("2026-11-20T10:00:00Z");

const project = { id: "p1", userId: "u1", name: "shop", slug: "shop", repoFullName: "me/shop", githubFullName: "me/shop", branch: "main", defaultBranch: "main", createdAt: T, buildContext: ".", dockerfilePath: "Dockerfile", containerId: null, hostPort: null };
const components = [
  { id: "c_web", projectId: "p1", kind: "frontend", name: "web", provider: "vercel", rootDir: "frontend", framework: "nextjs", installCmd: null, buildCmd: "next build", startCmd: null, outputDir: ".next", nodeVersion: "20", healthCheckPath: null, providerResourceId: "prj_1", url: "https://web.vercel.app", status: "live" },
  { id: "c_api", projectId: "p1", kind: "backend", name: "api", provider: "render", rootDir: "backend", framework: "express", installCmd: "npm install", buildCmd: null, startCmd: "node index.js", outputDir: null, nodeVersion: "20", healthCheckPath: "/health", providerResourceId: "srv-1", url: "https://api.onrender.com", status: "failed" },
];
const dep = (id: string, componentId: string | null, status: string, minutes: number) => ({
  id, projectId: "p1", componentId, provider: componentId ? "render" : "local_docker", status, trigger: "manual", commitSha: "a".repeat(40), commitMessage: "msg\nbody", errorMessage: status === "failed" ? `failed with ${SECRET}?` : null, providerStatus: status, queuedAt: new Date(T.getTime() + minutes * 60_000), finishedAt: null,
});
const deployments = [dep("d_api2", "c_api", "failed", 10), dep("d_api1", "c_api", "success", 5), dep("d_web1", "c_web", "success", 1)];

function setup(options: { logsDown?: boolean; docker?: boolean } = {}) {
  const prisma = {
    project: { findUnique: vi.fn(async () => (options.docker ? { ...project, containerId: "abc", hostPort: 3101 } : project)) },
    component: { findMany: vi.fn(async () => components) },
    deployment: {
      findMany: vi.fn(async ({ where }: { where: { componentId: string | null } }) =>
        (options.docker && where.componentId === null ? [dep("d_dock", null, "failed", 3)] : []).concat(deployments.filter((d) => d.componentId === where.componentId && where.componentId !== null) as never[]),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => deployments.find((d) => d.id === where.id) ?? null),
      findFirst: vi.fn(async () => deployments[1]),
    },
    analysis: { findFirst: vi.fn(async () => ({ database: { detected: true, engine: "postgres" }, components: [{ path: "backend", framework: "express", role: "backend" }] })) },
  } as unknown as PrismaClient;
  const componentsService = { preflight: vi.fn(async () => ({ ok: false, deployable: {}, checks: [{ id: "env:c_api", componentId: "c_api", status: "fail" as const, message: "api needs STRIPE_KEY" }] })) };
  const envVars = {
    list: vi.fn(async () => ({
      projectId: "p1",
      shared: [{ key: "NODE_ENV", isSecret: false, updatedAt: "" }],
      components: [
        { componentId: "c_api", name: "api", kind: "backend", provider: "render", vars: [{ key: "STRIPE_SECRET", isSecret: true, updatedAt: "" }], system: [{ key: "DATABASE_URL", source: "neon", from: "db", userWins: false }], receivesShared: true, revision: 2, pendingRedeploy: true },
      ],
    })),
    resolve: vi.fn(async () => ({ vars: [{ key: "STRIPE_SECRET", value: SECRET, secret: true }], secrets: [SECRET], revision: 2 })),
  };
  const releases = { list: vi.fn(async () => [{ number: 4, status: "failed", stage: 1, errorMessage: "Backend api failed", steps: [{ kind: "backend", componentName: "api", deployment: { status: "failed" } }] }]) };
  const entries = [
    { seq: 1, at: 1, source: "render", phase: "build", stream: "stdout", text: "npm install" },
    { seq: 2, at: 2, source: "render", phase: "build", stream: "stderr", text: "Error: STRIPE_SECRET is not defined" },
  ];
  const logs = {
    excerpt: vi.fn(async () => {
      if (options.logsDown) throw new Error("The logs service is not running");
      return { entries, totalLines: 2, errorLines: 1, truncated: false, status: "failed" };
    }),
    runtimeSnapshot: vi.fn(async () => ({ lines: [{ id: "r1", at: 3, stream: "stderr" as const, text: `charge failed with key ${SECRET} via ${DB_URL}` }], note: null })),
    dockerSnapshot: vi.fn(async () => ({ lines: [{ id: "d1", at: 3, stream: "stdout" as const, text: "listening on 3000" }], note: null })),
  };
  const builder = new AiContextBuilder(prisma, componentsService as never, envVars as never, releases as never, logs as never);
  return { builder, prisma, logs, envVars };
}

describe("AiContextBuilder", () => {
  it("builds the project bundle with env KEYS only, and never a secret value", async () => {
    const { builder } = setup();
    const bundle = await builder.forProject("u1", "p1");
    const json = JSON.stringify(bundle);
    expect(json).not.toContain(SECRET);
    const api = bundle.components.find((c) => c.id === "c_api")!;
    expect(api.env).toEqual({ keys: ["STRIPE_SECRET"], sharedKeys: ["NODE_ENV"], systemKeys: ["DATABASE_URL"], pendingRedeploy: true });
    expect(api.log?.entries[1].text).toBe("Error: STRIPE_SECRET is not defined");
    expect(api.runtime?.lines[0].text).not.toContain(SECRET);
    expect(json).not.toContain("neonpassword987");
    expect(api.deployments.map((d) => d.id)).toEqual(["d_api2", "d_api1"]);
    expect(api.deployments[0].commitMessage).toBe("msg");
    expect(bundle.components.find((c) => c.id === "c_web")!.runtime?.note).toMatch(/Vercel keeps no runtime-log history/);
    expect(bundle.release).toMatchObject({ number: 4, status: "failed", steps: [{ kind: "backend", componentName: "api", status: "failed" }] });
    expect(bundle.preflight).toEqual([{ id: "env:c_api", status: "fail", message: "api needs STRIPE_KEY" }]);
    expect(bundle.repoAnalysis?.database).toEqual({ detected: true, engine: "postgres" });
  });

  it("still builds a bundle when the logs service is down, with a note", async () => {
    const { builder } = setup({ logsDown: true });
    const bundle = await builder.forProject("u1", "p1");
    expect(bundle.components.every((c) => c.log === null)).toBe(true);
    expect(bundle.notes.join(" ")).toMatch(/build log of api could not be read/);
  });

  it("gives one component the detail (bigger log, last success) and the others only their facts", async () => {
    const { builder, logs } = setup();
    const bundle = await builder.forComponent("u1", "p1", "c_api", null);
    const api = bundle.components.find((c) => c.id === "c_api")!;
    const web = bundle.components.find((c) => c.id === "c_web")!;
    expect(logs.excerpt).toHaveBeenCalledWith("d_api2", "p1", 1200);
    expect(api.previousSuccessLog?.deploymentId).toBe("d_api1");
    expect(web.log).toBeNull();
    expect(web.settings.framework).toBe("nextjs");
  });

  it("refuses another user's project, an unknown component, and a deployment of another component", async () => {
    const { builder } = setup();
    await expect(builder.forProject("u2", "p1")).rejects.toMatchObject({ status: 404 });
    await expect(builder.forComponent("u1", "p1", "nope", null)).rejects.toMatchObject({ status: 404 });
    await expect(builder.forComponent("u1", "p1", "c_api", "d_web1")).rejects.toMatchObject({ status: 404 });
    await expect(builder.forComponent("u1", "p1", DOCKER_COMPONENT_ID, null)).rejects.toMatchObject({ status: 404 });
  });

  it("adds the local Docker deploys as the 'docker' entity, with its container logs", async () => {
    const { builder, logs } = setup({ docker: true });
    const bundle = await builder.forComponent("u1", "p1", DOCKER_COMPONENT_ID, null);
    const docker = bundle.components.find((c) => c.id === DOCKER_COMPONENT_ID)!;
    expect(docker).toMatchObject({ provider: "local_docker", status: "live", url: "http://localhost:3101" });
    expect(logs.dockerSnapshot).toHaveBeenCalledWith("orbitops-shop", { since: "1h", limit: 100 });
    expect(docker.runtime?.lines[0].text).toBe("listening on 3000");
  });
});

describe("AiService and parseAskBody", () => {
  it("sends the right scope and options to the AI service", async () => {
    const client = { analyze: vi.fn(async (input: unknown) => input), list: vi.fn(), get: vi.fn(), feedback: vi.fn() };
    const context = { forProject: vi.fn(async () => ({ components: [] })), forComponent: vi.fn(async () => ({ components: [] })) };
    const service = new AiService(client as never, context as never);
    await service.diagnose("u1", "p1", { question: "why?", force: true });
    expect(client.analyze).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "project", componentId: null, question: "why?", force: true }));
    await service.analyzeComponent("u1", "p1", "c_api", { deploymentId: "d1" });
    expect(context.forComponent).toHaveBeenCalledWith("u1", "p1", "c_api", "d1");
    expect(client.analyze).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "component", componentId: "c_api", deploymentId: "d1", question: null, force: false }));
  });

  it("trims the question and refuses one over 500 characters", () => {
    expect(parseAskBody(null)).toEqual({});
    expect(parseAskBody({ question: "  why  ", force: true })).toEqual({ question: "why", deploymentId: null, force: true });
    expect(() => parseAskBody({ question: "x".repeat(501) })).toThrow(/longer than 500/);
    expect(() => parseAskBody({ question: 5 })).toThrow(/text/);
  });
});
