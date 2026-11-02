import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const db = {
    component: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    project: { findFirst: vi.fn() },
    renderConnection: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    renderConfig: { count: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    renderDeployment: { findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(), $transaction: vi.fn(),
  };
  return { db, canAccess: vi.fn(), preflight: vi.fn(), ai: vi.fn() };
});
vi.mock("@/lib/db/prisma", () => ({ default: mocks.db }));
vi.mock("@/lib/runtime", () => ({ services: () => ({ githubUser: { canAccess: mocks.canAccess }, components: { preflight: mocks.preflight } }) }));
vi.mock("@/lib/log-analysis/log-analysis.service", () => ({ analyzeDeploymentLogs: mocks.ai }));
import { seal } from "@/lib/crypto/secret-box";
import { deploy, sync, analyze, saveConfig, connect } from "./service";

const now = new Date();
const db = mocks.db;
const config = () => ({ componentId: "c1", ownerId: "usr-owner", serviceName: "orbitops-c1", runtime: "node", region: "singapore", plan: "free", healthCheckPath: "/health", envEnc: seal('{"PASSWORD":"old-secret"}'), serviceId: null as string | null, updatedAt: now });
const component = () => ({ id: "c1", projectId: "p1", kind: "backend", provider: "render", startCmd: "npm start", installCmd: "npm ci", buildCmd: "npm run build", rootDir: "backend", nodeVersion: null, updatedAt: now,
  project: { id: "p1", userId: "u1", name: "Demo", repoFullName: "owner/repo", branch: "main" }, renderConfig: config() });
const run = () => ({ id: "r1", componentId: "c1", requestKey: "request-1234567890", status: "submitting", phase: "create", deployId: null as string | null, error: null, logs: "", logWarning: null, analysis: null, analysisError: null, createdAt: new Date(Date.now() - 120_000), finishedAt: null,
  secretSnapshotEnc: seal('["old-secret"]'), config: { ...config(), component: component() } });
const requestBody = { componentId: "c1", requestKey: "request-1234567890" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 8).toString("base64"));
  vi.stubEnv("GROQ_API_KEY", "test-groq-key");
  db.component.findFirst.mockResolvedValue(component());
  db.component.findUniqueOrThrow.mockResolvedValue(component());
  db.renderConnection.findUnique.mockResolvedValue({ userId: "u1", ownerId: "usr-owner", tokenEnc: seal("test-render-token"), updatedAt: now });
  db.renderConfig.findUniqueOrThrow.mockResolvedValue(config());
  db.renderConfig.findUnique.mockResolvedValue(config());
  db.renderConfig.count.mockResolvedValue(0);
  db.renderDeployment.count.mockResolvedValue(0);
  db.renderDeployment.findUnique.mockResolvedValue(null);
  db.renderDeployment.findFirst.mockResolvedValue(run());
  db.renderDeployment.create.mockResolvedValue(run());
  db.renderDeployment.update.mockImplementation(async ({ data }) => ({ ...run(), ...data }));
  db.renderDeployment.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async fn => fn(db));
  mocks.canAccess.mockResolvedValue(true);
  mocks.preflight.mockResolvedValue({ ok: true, checks: [] });
  vi.stubGlobal("fetch", vi.fn());
});

describe("Render deployment workflow", () => {
  it("rejects cross-user component access before contacting Render", async () => {
    db.component.findFirst.mockResolvedValue(null);
    await expect(deploy("u2", "p1", requestBody)).rejects.toMatchObject({ status: 404 });
    expect(db.component.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ project: { userId: "u2" } }) }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("creates a service with manual deploys and the selected backend folder", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ service: { id: "srv-first", serviceDetails: { url: "https://test.onrender.com" } }, deployId: "dep-first" }));
    expect(await deploy("u1", "p1", requestBody)).toMatchObject({ status: "deploying" });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ type: "web_service", ownerId: "usr-owner", rootDir: "backend", autoDeployTrigger: "off", serviceDetails: { plan: "free", envSpecificDetails: { buildCommand: "npm ci && npm run build", startCommand: "npm start" } } });
    expect(db.renderDeployment.create.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fetch).mock.invocationCallOrder[0]);
    expect(db.renderConfig.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ serviceId: "srv-first" }) }));
  });
  it("returns the original record for the same request key without a second POST", async () => {
    db.renderDeployment.findUnique.mockResolvedValue(run());
    await deploy("u1", "p1", requestBody);
    expect(fetch).not.toHaveBeenCalled(); expect(db.renderDeployment.create).not.toHaveBeenCalled();
  });
  it("blocks a second active deployment", async () => {
    db.renderDeployment.count.mockResolvedValue(1);
    await expect(deploy("u1", "p1", requestBody)).rejects.toMatchObject({ status: 409 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps a creation timeout uncertain instead of retrying", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));
    expect(await deploy("u1", "p1", requestBody)).toMatchObject({ status: "uncertain" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("marks a definitive rejection failed", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("sensitive provider error", { status: 400 }));
    const result = await deploy("u1", "p1", requestBody);
    expect(result.status).toBe("failed"); expect(result.error).not.toContain("sensitive");
  });
  it("reuses an existing service and explicitly triggers a single deploy", async () => {
    db.component.findFirst.mockResolvedValue({ ...component(), renderConfig: { ...config(), serviceId: "srv-existing" } });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: "srv-existing", ownerId: "usr-owner" })).mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json({ id: "dep-next" }));
    expect((await deploy("u1", "p1", requestBody)).status).toBe("deploying");
    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://api.render.com/v1/services/srv-existing", "GET"], ["https://api.render.com/v1/services/srv-existing", "PATCH"],
      ["https://api.render.com/v1/services/srv-existing/env-vars", "PUT"], ["https://api.render.com/v1/services/srv-existing/deploys", "POST"],
    ]);
  });
  it("blocks deployment when GitHub access has been revoked", async () => {
    mocks.canAccess.mockResolvedValue(false);
    await expect(deploy("u1", "p1", requestBody)).rejects.toMatchObject({ status: 403 }); expect(fetch).not.toHaveBeenCalled();
  });
  it("enforces preflight on the server even when the client bypasses it", async () => {
    mocks.preflight.mockResolvedValue({ ok: false, checks: [{ status: "fail", message: "DATABASE_URL missing" }] });
    await expect(deploy("u1", "p1", requestBody)).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
  it("blocks config changes during an active deployment", async () => {
    db.renderDeployment.count.mockResolvedValue(1);
    await expect(saveConfig("u1", "p1", { componentId: "c1", runtime: "node", region: "singapore", plan: "free", envVars: {} })).rejects.toMatchObject({ status: 409 });
  });
  it("requires a real encryption key before accepting Render credentials", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    await expect(connect("u1", { apiKey: "test" })).rejects.toMatchObject({ status: 503 }); expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves terminal rejection status when refreshing a request never accepted", async () => {
    db.renderDeployment.findFirst.mockResolvedValue({ ...run(), status: "failed" });
    expect((await sync("u1", "p1", "r1")).status).toBe("failed"); expect(fetch).not.toHaveBeenCalled();
  });
  it("reconciles a timed-out initial creation using its deterministic service name", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ service: { id: "srv-found", name: "orbitops-c1", ownerId: "usr-owner" } }]))
      .mockResolvedValueOnce(Response.json([{ deploy: { id: "dep-found", createdAt: new Date().toISOString() } }]))
      .mockResolvedValueOnce(Response.json({ id: "dep-found", status: "build_in_progress" }))
      .mockResolvedValueOnce(Response.json({ logs: [], hasMore: false }))
      .mockResolvedValueOnce(Response.json({ id: "srv-found", serviceDetails: { url: "https://test.onrender.com" } }));
    expect((await sync("u1", "p1", "r1")).status).toBe("deploying");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(db.renderDeployment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deployId: "dep-found" }) }));
  });
  it("does not guess when more than one remote deploy could match", async () => {
    db.renderDeployment.findFirst.mockResolvedValue({ ...run(), config: { ...run().config, serviceId: "srv-existing" } });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([1, 2].map(i => ({ deploy: { id: `dep-${i}`, createdAt: new Date().toISOString() } }))));
    expect((await sync("u1", "p1", "r1")).status).toBe("uncertain");
  });
  it("updates status even when the logs endpoint fails", async () => {
    db.renderDeployment.findFirst.mockResolvedValue({ ...run(), deployId: "dep-1", config: { ...run().config, serviceId: "srv-1" } });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: "dep-1", status: "build_failed" })).mockResolvedValueOnce(new Response("no logs", { status: 503 })).mockResolvedValueOnce(Response.json({ id: "srv-1" }));
    expect(await sync("u1", "p1", "r1")).toMatchObject({ status: "failed", logWarning: expect.stringContaining("unavailable") });
  });
  it("redacts secrets captured at deployment time after configuration changes", async () => {
    db.renderDeployment.findFirst.mockResolvedValue({ ...run(), deployId: "dep-1", config: { ...run().config, serviceId: "srv-1", envEnc: seal('{"PASSWORD":"new-secret"}') } });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: "dep-1", status: "build_failed" })).mockResolvedValueOnce(Response.json({ logs: [{ id: "l1", timestamp: new Date().toISOString(), message: "Failed with old-secret" }], hasMore: false })).mockResolvedValueOnce(Response.json({ id: "srv-1" }));
    const result = await sync("u1", "p1", "r1"); expect(result.logs).toContain("[REDACTED]"); expect(result.logs).not.toContain("old-secret");
  });
  it("checks ownership before analyzing and never accepts caller-supplied logs", async () => {
    db.renderDeployment.findFirst.mockResolvedValue(null);
    await expect(analyze("u2", "p1", "r1")).rejects.toMatchObject({ status: 404 }); expect(mocks.ai).not.toHaveBeenCalled();
  });
  it("returns cached AI results without another billable call", async () => {
    const analysis = { analysis: { summary: "Missing dependency" } };
    db.renderDeployment.findFirst.mockResolvedValue({ ...run(), status: "failed", analysis });
    expect(await analyze("u1", "p1", "r1")).toEqual(analysis); expect(mocks.ai).not.toHaveBeenCalled();
  });
  it("uses persisted logs for failure analysis and contains upstream errors", async () => {
    db.renderDeployment.findFirst.mockResolvedValue({ ...run(), status: "failed", logs: "error: missing dependency" });
    mocks.ai.mockRejectedValue(new Error("secret upstream error"));
    await expect(analyze("u1", "p1", "r1")).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining("secret") });
    expect(mocks.ai).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: "r1", source: "deployment", logs: "error: missing dependency" }));
  });
});
