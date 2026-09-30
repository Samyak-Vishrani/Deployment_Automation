import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GithubAppService, GithubError } from "@/lib/github/github-app.service";

const REPO = { owner: "owner", repo: "repo", fullName: "owner/repo" };
const SHA = "0123456789abcdef0123456789abcdef01234567";

const mockFetch = vi.fn();
const respond = (status: number, body: unknown) =>
  mockFetch.mockResolvedValue({ status, text: async () => JSON.stringify(body) });

function makeService() {
  const service = new GithubAppService();
  // Minting a real token needs the App private key; the branch lookup is what
  // is under test here.
  vi.spyOn(service, "getInstallationToken").mockResolvedValue("ghs_token");
  return service;
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GithubAppService.getBranchHeadSha", () => {
  it("returns the commit the branch points at", async () => {
    respond(200, { name: "main", commit: { sha: SHA } });

    await expect(makeService().getBranchHeadSha(REPO, "main", "inst_1")).resolves.toBe(SHA);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/branches/main",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer ghs_token" }),
      }),
    );
  });

  it("encodes a slashed branch name", async () => {
    respond(200, { commit: { sha: SHA } });

    await makeService().getBranchHeadSha(REPO, "feature/x", "inst_1");

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/branches/feature%2Fx",
    );
  });

  it("throws a 404 GithubError for a branch that does not exist", async () => {
    respond(404, { message: "Branch not found" });

    const error = await makeService()
      .getBranchHeadSha(REPO, "nope", "inst_1")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).status).toBe(404);
    expect((error as GithubError).message).toContain('Branch "nope"');
  });

  it("throws a 502 GithubError on any other failure", async () => {
    respond(500, { message: "Server Error" });

    const error = await makeService()
      .getBranchHeadSha(REPO, "main", "inst_1")
      .catch((e: unknown) => e);

    expect((error as GithubError).status).toBe(502);
  });
});
