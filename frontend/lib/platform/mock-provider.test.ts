import { describe, expect, it } from "vitest";
import { MockPlatformProvider } from "./mock-provider";

describe("MockPlatformProvider", () => {
  it("starts with seeded projects and pipeline history", async () => {
    const provider = new MockPlatformProvider();
    const projects = await provider.listProjects();
    const runs = await provider.listPipelineRuns(projects[0].id);

    expect(projects.length).toBeGreaterThanOrEqual(2);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].stages).toHaveLength(6);
  });

  it("creates a project through the typed onboarding contract", async () => {
    const provider = new MockPlatformProvider();
    const project = await provider.createProject({
      name: "Checkout Service",
      slug: "checkout-service",
      description: "A service for checkout events.",
      repoUrl: "https://github.com/orbitops-labs/checkout-service",
      branch: "main",
      environment: "development",
      port: 3000,
      healthPath: "/health",
      buildPreset: "node",
    });

    expect(project.slug).toBe("checkout-service");
    expect(project.repo.owner).toBe("orbitops-labs");
    expect(project.status).toBe("offline");
  });

  it("allows an active run to be canceled", async () => {
    const provider = new MockPlatformProvider();
    const project = (await provider.listProjects())[0];
    const run = await provider.triggerPipeline(project.id);
    const canceled = await provider.cancelPipeline(run.id);

    expect(canceled?.status).toBe("canceled");
    expect(canceled?.stages.every((stage) => stage.status !== "running")).toBe(true);
  });
});
