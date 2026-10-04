import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireUser, mockListRepositories, mockListBranches, mockProjectIds } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockListRepositories: vi.fn(),
  mockListBranches: vi.fn(),
  mockProjectIds: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({ requireUser: () => mockRequireUser() }));
vi.mock("@/lib/runtime", () => ({
  services: () => ({
    github: { installUrl: "https://github.com/apps/orbitops/installations/new" },
    githubUser: { listRepositories: mockListRepositories, listBranches: mockListBranches },
    projects: { projectIdsByRepoId: mockProjectIds },
  }),
}));

import { HttpError, unauthorized } from "@/lib/api/http-error";
import { GET as listRepositories } from "./route";
import { GET as listBranches } from "./[owner]/[repo]/branches/route";

const repo = (id: number) => ({
  id,
  fullName: `owner/repo-${id}`,
  owner: "owner",
  name: `repo-${id}`,
  private: false,
  defaultBranch: "main",
  installationId: "1",
  pushedAt: null,
});

const branches = (owner: string, name: string) =>
  listBranches(new Request(`http://localhost:3001/api/repositories/${owner}/${name}/branches`), {
    params: Promise.resolve({ owner, repo: name }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: "user_1" });
});

describe("GET /api/repositories", () => {
  it("lists repositories and marks the connected ones", async () => {
    mockListRepositories.mockResolvedValue({
      installations: [{ id: "1", account: "owner", accountType: "User", repositorySelection: "all", manageUrl: "m" }],
      repositories: [repo(1), repo(2)],
      truncated: false,
    });
    mockProjectIds.mockResolvedValue(new Map([[2, "project_2"]]));

    const response = await listRepositories();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      installUrl: "https://github.com/apps/orbitops/installations/new",
      installations: [{ id: "1", account: "owner", accountType: "User", repositorySelection: "all", manageUrl: "m" }],
      repositories: [
        { ...repo(1), projectId: null },
        { ...repo(2), projectId: "project_2" },
      ],
      truncated: false,
    });
    expect(mockListRepositories).toHaveBeenCalledWith("user_1");
    expect(mockProjectIds).toHaveBeenCalledWith("user_1");
  });

  it("answers 401 when signed out", async () => {
    mockRequireUser.mockRejectedValue(unauthorized());

    const response = await listRepositories();

    expect(response.status).toBe(401);
    expect(mockListRepositories).not.toHaveBeenCalled();
  });

  it("passes github_reconnect_required through", async () => {
    mockListRepositories.mockRejectedValue(new HttpError("Reconnect.", 409, "github_reconnect_required"));
    mockProjectIds.mockResolvedValue(new Map());

    const response = await listRepositories();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "github_reconnect_required" });
  });
});

describe("GET /api/repositories/:owner/:repo/branches", () => {
  it("lists the branches as the signed-in user", async () => {
    mockListBranches.mockResolvedValue({ defaultBranch: "main", branches: [{ name: "main", protected: true }] });

    const response = await branches("owner", "repo");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      defaultBranch: "main",
      branches: [{ name: "main", protected: true }],
    });
    expect(mockListBranches).toHaveBeenCalledWith("user_1", {
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
    });
  });

  it.each([
    ["-bad", "repo"],
    ["owner", "re po"],
    ["owner", ".."],
  ])("answers 400 for %s/%s", async (owner, name) => {
    const response = await branches(owner, name);

    expect(response.status).toBe(400);
    expect(mockListBranches).not.toHaveBeenCalled();
  });

  it("answers 401 when signed out", async () => {
    mockRequireUser.mockRejectedValue(unauthorized());

    expect((await branches("owner", "repo")).status).toBe(401);
  });
});
