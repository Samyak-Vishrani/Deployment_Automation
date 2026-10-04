import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { DockerService } from "@/lib/docker/docker.service";
import type { EventsService } from "@/lib/events/events.service";
import { GithubError, type GithubAppService } from "@/lib/github/github-app.service";
import type { GithubUserService } from "@/lib/github/github-user.service";
import { ProjectsService } from "@/lib/projects/projects.service";

const notInstalled = new GithubError(
  "The GitHub App is not installed on someone/private (or the repository does not exist). Install it here: x",
  404,
);

const github = {
  getRepoMetadata: vi.fn(),
  branchExists: vi.fn(),
  notInstalled: vi.fn(() => notInstalled),
};
const githubUser = { canAccess: vi.fn() };
const prisma = { $transaction: vi.fn() };

function makeService() {
  return new ProjectsService(
    prisma as unknown as PrismaClient,
    github as unknown as GithubAppService,
    githubUser as unknown as GithubUserService,
    {} as DockerService,
    { projectChanged: vi.fn() } as unknown as EventsService,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProjectsService.create", () => {
  it("rejects a repository the user cannot access, before the App reads it", async () => {
    githubUser.canAccess.mockResolvedValue(false);

    const error = await makeService()
      .create("user_b", { repoUrl: "https://github.com/someone/private" })
      .catch((e: unknown) => e);

    expect(error).toBe(notInstalled);
    expect(githubUser.canAccess).toHaveBeenCalledWith("user_b", {
      owner: "someone",
      repo: "private",
      fullName: "someone/private",
    });
    expect(github.getRepoMetadata).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("goes on to read the repository when the user can access it", async () => {
    githubUser.canAccess.mockResolvedValue(true);
    github.getRepoMetadata.mockRejectedValue(new Error("stop here"));

    await expect(
      makeService().create("user_a", { repoUrl: "https://github.com/owner/repo" }),
    ).rejects.toThrow("stop here");
    expect(github.getRepoMetadata).toHaveBeenCalledTimes(1);
  });

  it("validates the URL before asking GitHub anything", async () => {
    await expect(makeService().create("user_a", { repoUrl: "https://gitlab.com/a/b" })).rejects.toMatchObject({
      status: 400,
    });
    expect(githubUser.canAccess).not.toHaveBeenCalled();
  });
});
