import { describe, expect, it } from "vitest";
import { evidenceHref, stepHref, verdictOf, WHERE_LABEL } from "./ai-format";

describe("AI analysis display helpers (Phase 13)", () => {
  it("links evidence to the component's Logs tab and the deployment", () => {
    expect(evidenceHref("p1", "c_api", "d_9")).toBe("/deploy/p1/logs?c=c_api&d=d_9");
    expect(evidenceHref("p1", "docker", null)).toBe("/deploy/p1/logs?c=docker");
    expect(evidenceHref("p1", null, null)).toBe("/deploy/p1/logs");
  });

  it("sends each step to where it is done in OrbitOps, or nowhere", () => {
    expect(stepHref("p1", "environment")).toBe("/deploy/p1/configure");
    expect(stepHref("p1", "configure")).toBe("/deploy/p1/configure");
    expect(stepHref("p1", "settings")).toBe("/settings");
    expect(stepHref("p1", "redeploy")).toBe("/deploy/p1");
    expect(stepHref("p1", "repository")).toBeNull();
    expect(stepHref("p1", "provider_dashboard")).toBeNull();
    expect(Object.keys(WHERE_LABEL)).toHaveLength(6);
  });

  it("reads an unexpected verdict as unknown", () => {
    expect(verdictOf({ verdict: "failing" })).toBe("failing");
    expect(verdictOf({ verdict: "exploded" as never })).toBe("unknown");
  });
});
