import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeDir } from "../common/fs-utils";
import type { ComponentSpec, RepoSpec } from "../types";
import { settingsHash, toProjectSettings } from "./project-settings";
import { setVercelApiBase } from "./vercel-http";
import { VercelProvider, type KnownProject } from "./vercel.provider";

/**
 * A fake Vercel API: each test lists the responses for "METHOD /path" in order,
 * and every call is recorded with its parsed JSON body.
 */
type Handler = { status: number; body?: unknown };
let routes: Map<string, Handler[]>;
let calls: Array<{ method: string; path: string; query: URLSearchParams; body: unknown; headers: Record<string, string> }>;

function on(method: string, path: string, ...responses: Handler[]) {
  routes.set(`${method} ${path}`, [...(routes.get(`${method} ${path}`) ?? []), ...responses]);
}

beforeEach(() => {
  setVercelApiBase("https://vercel.test");
  routes = new Map();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const method = (init.method ?? "GET").toUpperCase();
      const raw = init.body;
      let body: unknown = raw;
      if (typeof raw === "string") {
        try {
          body = JSON.parse(raw);
        } catch {
          /* raw text */
        }
      }
      calls.push({ method, path: url.pathname, query: url.searchParams, body, headers: init.headers as Record<string, string> });
      const queue = routes.get(`${method} ${url.pathname}`);
      const handler = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      if (!handler) return new Response(JSON.stringify({ error: { code: "not_mocked" } }), { status: 500 });
      return new Response(handler.body === undefined ? null : JSON.stringify(handler.body), { status: handler.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx = { token: "tok_1234567890", teamId: "team_1" };
const repo: RepoSpec = { fullName: "me/shop", repoId: 42, branch: "main" };
const component: ComponentSpec = {
  id: "comp1",
  name: "web",
  rootDir: "frontend",
  framework: "nextjs",
  installCmd: "npm install",
  buildCmd: "npm run build",
  outputDir: ".next",
  nodeVersion: "20",
};
const SHA = "a".repeat(40);
const log = () => undefined;

describe("ensureProject", () => {
  it("creates a Git-linked project, sets the node version and turns off deploy-on-push", async () => {
    on("POST", "/v11/projects", { status: 200, body: { id: "prj_1", name: "shop-web" } });
    on("PATCH", "/v9/projects/prj_1", { status: 200, body: {} });

    const project = await new VercelProvider().ensureProject(ctx, null, component, repo, log);

    expect(project).toMatchObject({ vercelProjectId: "prj_1", name: "shop-web", gitLinked: true, created: true });
    const create = calls[0];
    expect(create.query.get("teamId")).toBe("team_1");
    expect(create.body).toMatchObject({
      name: "shop-web",
      framework: "nextjs",
      rootDirectory: "frontend",
      outputDirectory: null,
      gitRepository: { type: "github", repo: "me/shop" },
    });
    const patches = calls.filter((c) => c.method === "PATCH").map((c) => c.body);
    expect(patches).toContainEqual(expect.objectContaining({ nodeVersion: "20.x" }));
    expect(patches).toContainEqual({ gitProviderOptions: { createDeployments: "disabled" } });
  });

  it("creates an unlinked project when Vercel's GitHub app cannot see the repo", async () => {
    on(
      "POST",
      "/v11/projects",
      { status: 400, body: { error: { code: "bad_request", message: "To link a GitHub repository, you need to install the GitHub integration first." } } },
      { status: 200, body: { id: "prj_2", name: "shop-web" } },
    );
    on("PATCH", "/v9/projects/prj_2", { status: 200, body: {} });

    const project = await new VercelProvider().ensureProject(ctx, null, component, repo, log);

    expect(project.gitLinked).toBe(false);
    expect(calls[1].body).not.toHaveProperty("gitRepository");
    expect(calls.some((c) => JSON.stringify(c.body).includes("createDeployments"))).toBe(false);
  });

  it("picks another name when the first is taken", async () => {
    on(
      "POST",
      "/v11/projects",
      { status: 409, body: { error: { code: "conflict", message: "Project already exists" } } },
      { status: 200, body: { id: "prj_3", name: "shop-web-abcd" } },
    );
    on("PATCH", "/v9/projects/prj_3", { status: 200, body: {} });

    const project = await new VercelProvider().ensureProject(ctx, null, component, repo, log);
    expect((calls[1].body as { name: string }).name).toMatch(/^shop-web-[a-z0-9]{4}$/);
    expect(project.vercelProjectId).toBe("prj_3");
  });

  const known: KnownProject = {
    vercelProjectId: "prj_9",
    name: "shop-web",
    gitLinked: true,
    settingsHash: settingsHash(toProjectSettings(component)),
  };

  it("does nothing when the project exists and settings are unchanged", async () => {
    on("GET", "/v9/projects/prj_9", { status: 200, body: { id: "prj_9" } });
    const project = await new VercelProvider().ensureProject(ctx, known, component, repo, log);
    expect(project).toMatchObject({ created: false, updated: false });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("PATCHes when a build setting changed", async () => {
    on("GET", "/v9/projects/prj_9", { status: 200, body: { id: "prj_9" } });
    on("PATCH", "/v9/projects/prj_9", { status: 200, body: {} });
    const changed = { ...component, buildCmd: "pnpm build" };
    const project = await new VercelProvider().ensureProject(ctx, known, changed, repo, log);
    expect(project.updated).toBe(true);
    expect(calls[1].body).toMatchObject({ buildCommand: "pnpm build" });
  });

  it("recreates a project that was deleted on Vercel", async () => {
    on("GET", "/v9/projects/prj_9", { status: 404, body: { error: { code: "not_found" } } });
    on("POST", "/v11/projects", { status: 200, body: { id: "prj_10", name: "shop-web" } });
    on("PATCH", "/v9/projects/prj_10", { status: 200, body: {} });
    const project = await new VercelProvider().ensureProject(ctx, known, component, repo, log);
    expect(project).toMatchObject({ vercelProjectId: "prj_10", created: true });
  });
});

describe("deploy", () => {
  const linked: KnownProject = { vercelProjectId: "prj_1", name: "shop-web", gitLinked: true, settingsHash: "h" };

  it("deploys a linked project from its Git source at the exact commit", async () => {
    on("POST", "/v13/deployments", {
      status: 200,
      body: { id: "dpl_1", url: "shop-web-abc.vercel.app", inspectorUrl: "https://vercel.com/i/1", readyState: "QUEUED" },
    });
    const result = await new VercelProvider().deploy(ctx, { project: linked, repo, commitSha: SHA, deploymentId: "d1", log });

    expect(result).toEqual({
      providerDeploymentId: "dpl_1",
      url: "https://shop-web-abc.vercel.app",
      inspectorUrl: "https://vercel.com/i/1",
      sourceMode: "git",
      readyState: "queued",
    });
    expect(calls[0].body).toMatchObject({
      project: "prj_1",
      target: "production",
      gitSource: { type: "github", repoId: 42, ref: "main", sha: SHA },
    });
  });

  describe("upload", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "vercel-upload-"));
      await mkdir(join(dir, "frontend"), { recursive: true });
      await mkdir(join(dir, "node_modules", "x"), { recursive: true });
      await writeFile(join(dir, "frontend", "page.tsx"), "export default 1");
      await writeFile(join(dir, "package.json"), "{}");
      await writeFile(join(dir, "node_modules", "x", "index.js"), "ignored");
      await writeFile(join(dir, ".env"), "SECRET=1");
    });
    afterEach(async () => {
      await removeDir(dir);
    });

    it("falls back to upload when Vercel rejects the Git source, sending only missing files", async () => {
      on(
        "POST",
        "/v13/deployments",
        { status: 400, body: { error: { code: "incorrect_git_source_info", message: "Could not access the GitHub repository" } } },
        { status: 400, body: { error: { code: "missing_files", missing: ["MISSING"] } } },
        { status: 200, body: { id: "dpl_2", url: "x.vercel.app", readyState: "QUEUED" } },
      );
      on("POST", "/v2/files", { status: 200, body: {} });

      const result = await new VercelProvider().deploy(ctx, {
        project: linked,
        repo,
        commitSha: SHA,
        deploymentId: "d2",
        log,
        prepareUpload: async () => dir,
      });

      expect(result.sourceMode).toBe("upload");
      const fileList = (calls[1].body as { files: Array<{ file: string }> }).files.map((f) => f.file);
      expect(fileList).toEqual(["frontend/page.tsx", "package.json"]);
      // "MISSING" matches no file we hold, so nothing is uploaded; the retry still happens.
      expect(calls.filter((c) => c.path === "/v13/deployments")).toHaveLength(3);
    });

    it("uploads the files Vercel asks for", async () => {
      const unlinked = { ...linked, gitLinked: false };
      on("POST", "/v13/deployments", { status: 200, body: { id: "dpl_3", url: "y.vercel.app", readyState: "QUEUED" } });
      const provider = new VercelProvider();

      // First discover the SHA of package.json from the request body, then make Vercel ask for it.
      routes.set("POST /v13/deployments", []);
      let first = true;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body, headers: init?.headers as Record<string, string> });
        if (url.pathname === "/v13/deployments" && first) {
          first = false;
          const pkg = (body.files as Array<{ file: string; sha: string }>).find((f) => f.file === "package.json")!;
          return new Response(JSON.stringify({ error: { code: "missing_files", missing: [pkg.sha] } }), { status: 400 });
        }
        if (url.pathname === "/v2/files") return new Response("{}", { status: 200 });
        return new Response(JSON.stringify({ id: "dpl_3", url: "y.vercel.app", readyState: "QUEUED" }), { status: 200 });
      });

      const result = await provider.deploy(ctx, {
        project: unlinked,
        repo,
        commitSha: SHA,
        deploymentId: "d3",
        log,
        prepareUpload: async () => dir,
      });

      expect(result.providerDeploymentId).toBe("dpl_3");
      const uploads = calls.filter((c) => c.path === "/v2/files");
      expect(uploads).toHaveLength(1);
      expect(uploads[0].headers["x-vercel-digest"]).toMatch(/^[0-9a-f]{40}$/);
    });

    it("refuses to upload without a GitHub token", async () => {
      const unlinked = { ...linked, gitLinked: false };
      await expect(
        new VercelProvider().deploy(ctx, { project: unlinked, repo, commitSha: SHA, deploymentId: "d4", log }),
      ).rejects.toMatchObject({ code: "vercel_upload_unavailable" });
    });
  });
});

describe("status and logs", () => {
  it("reports live with the production URL", async () => {
    on("GET", "/v13/deployments/dpl_1", {
      status: 200,
      body: { readyState: "READY", url: "shop-web-abc.vercel.app", alias: ["shop-web.vercel.app"] },
    });
    const status = await new VercelProvider().getStatus(ctx, "dpl_1", "shop-web");
    expect(status).toMatchObject({ status: "live", productionUrl: "https://shop-web.vercel.app" });
  });

  it("reads build events after a timestamp", async () => {
    on("GET", "/v3/deployments/dpl_1/events", {
      status: 200,
      body: [{ type: "stdout", created: 5, payload: { text: "hello", id: "e1" } }],
    });
    const lines = await new VercelProvider().getLogs(ctx, "dpl_1", 4);
    expect(lines).toEqual([{ id: "e1", at: 5, stream: "stdout", text: "hello" }]);
    expect(calls[0].query.get("since")).toBe("4");
    expect(calls[0].query.get("builds")).toBe("1");
  });

  it("treats cancelling an already-finished deployment as done", async () => {
    on("PATCH", "/v12/deployments/dpl_1/cancel", { status: 400, body: { error: { code: "bad_request" } } });
    await expect(new VercelProvider().cancel(ctx, "dpl_1")).resolves.toBeUndefined();
  });
});

describe("validateCredentials", () => {
  it("returns the account and the teams it can see", async () => {
    on("GET", "/v2/user", { status: 200, body: { user: { id: "u1", username: "samyak", defaultTeamId: "team_1" } } });
    on("GET", "/v2/teams", { status: 200, body: { teams: [{ id: "team_1", slug: "samyak", name: "Samyak" }] } });
    const account = await new VercelProvider().validateCredentials("tok");
    expect(account).toEqual({
      accountId: "u1",
      accountName: "samyak",
      defaultTeamId: "team_1",
      teams: [{ id: "team_1", slug: "samyak", name: "Samyak" }],
    });
    // Validation happens without a team scope.
    expect(calls[0].query.get("teamId")).toBeNull();
  });

  it("rejects a bad token", async () => {
    on("GET", "/v2/user", { status: 403, body: { error: { code: "forbidden", invalidToken: true } } });
    await expect(new VercelProvider().validateCredentials("bad")).rejects.toMatchObject({ code: "vercel_token_invalid" });
  });
});
