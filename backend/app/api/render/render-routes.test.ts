import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), limit: vi.fn(), deploy: vi.fn(), analyze: vi.fn(), sync: vi.fn(), connect: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ requireUser: mocks.user }));
vi.mock("@/lib/render/service", () => ({ deploy: mocks.deploy, analyze: mocks.analyze, sync: mocks.sync, connect: mocks.connect, projectView: vi.fn(), saveConfig: vi.fn(), acknowledgeUncertain: vi.fn(), connectionView: vi.fn(), disconnect: vi.fn() }));
vi.mock("@/lib/render/security", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/render/security")>(), rateLimit: mocks.limit }));
import { POST as projectPost } from "@/app/api/projects/[projectId]/render/route";
import { POST as analysisPost } from "@/app/api/log-analysis/analyze/route";
import { POST as connectionPost } from "@/app/api/render/connection/route";
import { unauthorized } from "@/lib/api/http-error";
const context = { params: Promise.resolve({ projectId: "p1" }) };
const request = (body: unknown, origin = "https://app.example.com") => new Request("https://api.example.com", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("FRONTEND_URL", "https://app.example.com");
  mocks.user.mockResolvedValue({ id: "u1" }); mocks.deploy.mockResolvedValue({ id: "r1" });
});
describe("Render route security", () => {
  it("rejects anonymous deploy, credential, and AI requests", async () => {
    mocks.user.mockRejectedValue(unauthorized());
    expect((await projectPost(request({ action: "deploy" }), context)).status).toBe(401);
    expect((await connectionPost(request({ apiKey: "secret" }))).status).toBe(401);
    expect((await analysisPost(request({ sampleLogId: "LOG-001" }))).status).toBe(401);
    expect(mocks.deploy).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it("rejects hostile origins before performing mutations", async () => {
    expect((await projectPost(request({ action: "deploy" }, "https://evil.example.com"), context)).status).toBe(403);
    expect((await analysisPost(request({ projectId: "p1", deploymentId: "r1" }, "null"))).status).toBe(403);
    expect(mocks.deploy).not.toHaveBeenCalled(); expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it("uses the authenticated user and route project, ignoring forged body ownership", async () => {
    const response = await projectPost(request({ action: "deploy", userId: "admin", projectId: "p2" }), context);
    expect(response.status).toBe(200);
    expect(mocks.deploy).toHaveBeenCalledWith("u1", "p1", expect.any(Object));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("does not accept the old sample-log or arbitrary-log API", async () => {
    expect((await analysisPost(request({ sampleLogId: "LOG-001", logs: "caller input" }))).status).toBe(400);
    expect(mocks.analyze).not.toHaveBeenCalled();
  });
});
