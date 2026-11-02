import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AnalysisResult, AnalysisService, PersistedComponent } from "@/lib/analysis/analysis.service";
import type { ComponentInput } from "@/lib/components/component-input";
import { ComponentsService, proposeComponents } from "@/lib/components/components.service";
import type { EventsService } from "@/lib/events/events.service";
import type { GithubAppService } from "@/lib/github/github-app.service";

const component = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  deleteMany: vi.fn(),
};
const prisma = {
  project: { findUnique: vi.fn() },
  component,
  $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({ component })),
};
const analysis = { getLatest: vi.fn(), analyze: vi.fn() };
const events = { projectChanged: vi.fn() };

function makeService() {
  return new ComponentsService(
    prisma as unknown as PrismaClient,
    {} as GithubAppService,
    analysis as unknown as AnalysisService,
    events as unknown as EventsService,
  );
}

const project = { id: "p1", userId: "u1", name: "shop", repo: "shop" };

function detected(overrides: Partial<PersistedComponent>): PersistedComponent {
  return {
    id: "pc",
    type: "node",
    role: "frontend",
    framework: "nextjs",
    language: "typescript",
    path: "frontend",
    packageManager: "npm",
    detectedVersion: null,
    confidence: 0.9,
    installCmd: "npm ci",
    buildCmd: "npm run build",
    startCmd: "npm start",
    outputDir: ".next",
    runtimeVersion: "20",
    evidence: ["frontend/package.json: next"],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function snapshot(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    projectId: "p1",
    projectName: "shop",
    repository: "me/shop",
    analysisId: "a1",
    branch: "main",
    commitSha: "abc",
    source: "tree",
    analyzedAt: "2026-11-02T00:00:00.000Z",
    reused: false,
    warnings: [],
    database: null,
    components: [],
    ...overrides,
  };
}

const input = (overrides: Partial<ComponentInput> = {}): ComponentInput => ({
  kind: "frontend",
  name: "web",
  rootDir: "frontend",
  framework: "nextjs",
  installCmd: null,
  buildCmd: "npm run build",
  startCmd: null,
  outputDir: ".next",
  nodeVersion: null,
  healthCheckPath: null,
  provider: "vercel",
  analysisComponentId: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.project.findUnique.mockResolvedValue(project);
});

describe("proposeComponents", () => {
  it("maps roles to kinds and providers, names by folder, and orders frontends first", () => {
    const result = proposeComponents(
      "shop",
      snapshot({
        components: [
          detected({ id: "b", role: "backend", path: "backend", framework: "express", outputDir: null }),
          detected({ id: "f", role: "frontend", path: "frontend" }),
        ],
      }),
    );
    expect(result.map((c) => [c.kind, c.provider, c.name, c.rootDir, c.analysisComponentId])).toEqual([
      ["frontend", "vercel", "frontend", "frontend", "f"],
      ["backend", "render", "backend", "backend", "b"],
    ]);
    expect(result[0]).toMatchObject({ buildCmd: "npm run build", outputDir: ".next", nodeVersion: "20" });
  });

  it("names a root component after the repository and leaves an unknown role for the user", () => {
    const [root] = proposeComponents("shop", snapshot({ components: [detected({ role: "unknown", path: "." })] }));
    expect(root).toMatchObject({ kind: null, provider: null, name: "shop", rootDir: "." });
  });

  it("collapses two detections of one folder", () => {
    const result = proposeComponents(
      "shop",
      snapshot({ components: [detected({ id: "1" }), detected({ id: "2", type: "docker" })] }),
    );
    expect(result).toHaveLength(1);
  });

  it("proposes a Neon database when the analysis suggests one", () => {
    const result = proposeComponents(
      "shop",
      snapshot({
        database: { detected: true, engine: "postgres", evidence: ["backend/package.json: pg"], suggestNeon: true },
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({ kind: "database", provider: "neon", rootDir: ".", buildCmd: null }),
    ]);
  });
});

describe("ComponentsService.fromAnalysis", () => {
  it("uses the latest snapshot without re-analysing", async () => {
    analysis.getLatest.mockResolvedValue(snapshot({ components: [detected({})] }));
    const proposal = await makeService().fromAnalysis("u1", "p1");
    expect(proposal.analysisId).toBe("a1");
    expect(proposal.components).toHaveLength(1);
    expect(analysis.analyze).not.toHaveBeenCalled();
  });

  it("analyses a project that never was", async () => {
    analysis.getLatest.mockResolvedValue(snapshot({ analysisId: null }));
    analysis.analyze.mockResolvedValue(snapshot({ analysisId: "a2" }));
    expect((await makeService().fromAnalysis("u1", "p1")).analysisId).toBe("a2");
  });
});

describe("ComponentsService.replaceAll", () => {
  const live = {
    id: "c1",
    projectId: "p1",
    kind: "frontend",
    rootDir: "frontend",
    status: "live",
    providerResourceId: "prj_123",
    url: "https://shop.vercel.app",
    analysisComponentId: "pc_old",
  };

  it("updates a matched component in place, so its provider id and url survive", async () => {
    component.findMany.mockResolvedValueOnce([live]).mockResolvedValueOnce([]);
    component.update.mockResolvedValue({ ...live, id: "c1" });

    await makeService().replaceAll("u1", "p1", [input({ buildCmd: "pnpm build" })]);

    expect(component.create).not.toHaveBeenCalled();
    const { data } = component.update.mock.calls[0][0];
    expect(data.buildCmd).toBe("pnpm build");
    expect(data).not.toHaveProperty("providerResourceId");
    expect(data).not.toHaveProperty("url");
    // A live component is not knocked back to "configured" by an edit.
    expect(data).not.toHaveProperty("status");
    expect(data.analysisComponentId).toBe("pc_old");
    expect(component.deleteMany).toHaveBeenCalledWith({ where: { projectId: "p1", id: { notIn: ["c1"] } } });
    expect(events.projectChanged).toHaveBeenCalledWith("p1", "updated");
  });

  it("creates new components as configured and deletes the ones left out", async () => {
    component.findMany.mockResolvedValueOnce([live]).mockResolvedValueOnce([]);
    component.create.mockResolvedValue({ id: "c2" });

    await makeService().replaceAll("u1", "p1", [input({ kind: "backend", rootDir: "api", provider: "render" })]);

    expect(component.create.mock.calls[0][0].data).toMatchObject({
      projectId: "p1",
      kind: "backend",
      rootDir: "api",
      status: "configured",
    });
    expect(component.deleteMany).toHaveBeenCalledWith({ where: { projectId: "p1", id: { notIn: ["c2"] } } });
  });

  it("answers 404 for someone else's project, before touching components", async () => {
    prisma.project.findUnique.mockResolvedValue({ ...project, userId: "u2" });
    await expect(makeService().replaceAll("u1", "p1", [])).rejects.toMatchObject({ status: 404 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("ComponentsService.update", () => {
  it("rejects a provider the kind does not allow", async () => {
    component.findUnique.mockResolvedValue({ id: "c1", projectId: "p1", kind: "backend" });
    await expect(makeService().update("u1", "p1", "c1", { provider: "vercel" })).rejects.toMatchObject({
      status: 400,
    });
    expect(component.update).not.toHaveBeenCalled();
  });

  it("answers 404 for a component of another project", async () => {
    component.findUnique.mockResolvedValue({ id: "c1", projectId: "p9", kind: "backend" });
    await expect(makeService().update("u1", "p1", "c1", { name: "x" })).rejects.toMatchObject({ status: 404 });
  });
});
