import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireUser, mockAnalyze } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockAnalyze: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({ requireUser: () => mockRequireUser() }));
vi.mock("@/lib/runtime", () => ({
  services: () => ({ analysis: { analyze: mockAnalyze } }),
}));

import { HttpError, unauthorized } from "@/lib/api/http-error";
import { POST } from "./route";

const context = { params: Promise.resolve({ projectId: "project_1" }) };
const post = (query = "") =>
  POST(new Request(`http://localhost:3001/api/projects/project_1/analyze${query}`, { method: "POST" }), context);

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: "user_1" });
  mockAnalyze.mockResolvedValue({ projectId: "project_1", components: [] });
});

describe("POST /api/projects/:projectId/analyze", () => {
  it("analyses the project for the signed-in user", async () => {
    const response = await post();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ projectId: "project_1", components: [] });
    expect(mockAnalyze).toHaveBeenCalledWith("user_1", "project_1", { force: false });
  });

  it.each(["?force=1", "?force=true"])("forces a re-run with %s", async (query) => {
    await post(query);

    expect(mockAnalyze).toHaveBeenCalledWith("user_1", "project_1", { force: true });
  });

  it("answers 401 in the shared error shape when signed out", async () => {
    mockRequireUser.mockRejectedValue(unauthorized());

    const response = await post();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
      message: "Authentication required.",
    });
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("passes the service's status and code through", async () => {
    mockAnalyze.mockRejectedValue(
      new HttpError('Repository "owner/repo" not found or inaccessible.', 404, "repo_not_found"),
    );

    const response = await post();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "repo_not_found",
      message: 'Repository "owner/repo" not found or inaccessible.',
    });
  });
});
