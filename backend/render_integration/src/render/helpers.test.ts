import { describe, expect, it } from "vitest";
import type { ComponentSpec } from "../types";
import { envHash, keysToDelete, toEnvVars } from "./env-vars";
import { describeFailure, hintFor, safeServiceUrl } from "./error-hints";
import { toLogLine, toLogLines } from "./log-map";
import { renderRuntime } from "./runtime-map";
import { renderServiceName } from "./service-name";
import { createServiceBody, patchServiceBody, settingsHash, toServiceSettings } from "./service-settings";
import { normaliseDeployStatus } from "./status-map";

const component = (overrides: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id: "c1",
  name: "api",
  rootDir: "backend",
  framework: "express",
  installCmd: "npm install",
  buildCmd: null,
  startCmd: "npm start",
  nodeVersion: ">=20",
  healthCheckPath: "/health",
  ...overrides,
});
const repo = { fullName: "me/shop", branch: "main" };
const defaults = { region: "oregon", plan: "free" };

describe("renderRuntime", () => {
  it.each([
    ["nestjs", "node"],
    ["Express", "node"],
    ["fastapi", "python"],
    ["django", "python"],
    ["gin", "go"],
    ["rails", "ruby"],
    ["axum", "rust"],
    ["docker", "docker"],
    ["nextjs", null],
    [null, null],
  ])("%s → %s", (framework, expected) => {
    expect(renderRuntime(framework)).toBe(expected);
  });
});

describe("toServiceSettings", () => {
  it("joins install and build into Render's single build command", () => {
    const settings = toServiceSettings(component({ buildCmd: "npm run build" }), repo, defaults);
    expect(settings).toMatchObject({
      runtime: "node",
      rootDir: "backend",
      branch: "main",
      buildCommand: "npm install && npm run build",
      startCommand: "npm start",
      healthCheckPath: "/health",
      region: "oregon",
      plan: "free",
    });
  });

  it("maps the repository root to an empty rootDir", () => {
    expect(toServiceSettings(component({ rootDir: "." }), repo, defaults).rootDir).toBe("");
  });

  it("requires a start command for a native runtime", () => {
    expect(() => toServiceSettings(component({ startCmd: " " }), repo, defaults)).toThrow(
      expect.objectContaining({ code: "render_missing_start" }),
    );
  });

  it("refuses a framework Render cannot run", () => {
    expect(() => toServiceSettings(component({ framework: "nextjs" }), repo, defaults)).toThrow(
      expect.objectContaining({ code: "render_unknown_runtime" }),
    );
  });

  it("takes everything from the Dockerfile for a docker component", () => {
    const settings = toServiceSettings(component({ framework: "docker", startCmd: null }), repo, defaults);
    expect(settings).toMatchObject({
      runtime: "docker",
      buildCommand: null,
      startCommand: null,
      dockerfilePath: "./backend/Dockerfile",
      dockerContext: "./backend",
    });
  });

  it("hashes only what can be PATCHed", () => {
    const a = toServiceSettings(component(), repo, defaults);
    expect(settingsHash(a)).toBe(settingsHash(toServiceSettings(component(), repo, { region: "frankfurt", plan: "starter" })));
    expect(settingsHash(a)).not.toBe(settingsHash(toServiceSettings(component({ startCmd: "node dist/main" }), repo, defaults)));
  });

  it("builds create and patch bodies with auto-deploy off", () => {
    const settings = toServiceSettings(component(), repo, defaults);
    const create = createServiceBody("shop-api", "own_1", repo, settings, [{ key: "A", value: "1" }]);
    expect(create).toMatchObject({
      type: "web_service",
      name: "shop-api",
      ownerId: "own_1",
      repo: "https://github.com/me/shop",
      autoDeployTrigger: "off",
      envVars: [{ key: "A", value: "1" }],
      serviceDetails: {
        runtime: "node",
        plan: "free",
        region: "oregon",
        healthCheckPath: "/health",
        envSpecificDetails: { buildCommand: "npm install", startCommand: "npm start" },
      },
    });
    expect(patchServiceBody(settings)).toMatchObject({ autoDeployTrigger: "off", rootDir: "backend" });
    expect(patchServiceBody(settings)).not.toHaveProperty("serviceDetails.plan");
  });
});

describe("env vars", () => {
  it("adds NODE_VERSION from the component, keeps the project's own vars and drops invalid keys", () => {
    const vars = toEnvVars(
      [
        { key: "GREETING", value: "hi" },
        { key: "bad-key", value: "x" },
      ],
      component(),
      "node",
    );
    expect(vars).toEqual([
      { key: "GREETING", value: "hi" },
      { key: "NODE_VERSION", value: "20" },
    ]);
  });

  it("never overrides a NODE_VERSION the user set", () => {
    expect(toEnvVars([{ key: "NODE_VERSION", value: "22.3.0" }], component(), "node")).toEqual([
      { key: "NODE_VERSION", value: "22.3.0" },
    ]);
  });

  it("sets PYTHON_VERSION only from a fully specified version", () => {
    expect(toEnvVars([], component({ nodeVersion: "3.11" }), "python")).toEqual([]);
    expect(toEnvVars([], component({ nodeVersion: "3.11.9" }), "python")).toEqual([
      { key: "PYTHON_VERSION", value: "3.11.9" },
    ]);
  });

  it("hashes keys and values, order-independent", () => {
    const a = envHash([{ key: "A", value: "1" }, { key: "B", value: "2" }]);
    expect(envHash([{ key: "B", value: "2" }, { key: "A", value: "1" }])).toBe(a);
    expect(envHash([{ key: "A", value: "1" }, { key: "B", value: "3" }])).not.toBe(a);
  });

  it("deletes only keys it managed before", () => {
    expect(keysToDelete(["A", "B", "OLD"], [{ key: "A", value: "1" }, { key: "B", value: "2" }])).toEqual(["OLD"]);
  });
});

describe("renderServiceName", () => {
  it("joins repo and component as a DNS-safe slug", () => {
    expect(renderServiceName("Robert/Vercel_Integration_test", "backend")).toBe("vercel-integration-test-backend");
  });
  it("does not repeat a component named like the repo, and stays within 60 characters", () => {
    expect(renderServiceName("me/api", "api")).toBe("api");
    const long = renderServiceName(`me/${"a".repeat(80)}`, "api", "x1y2");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("-x1y2")).toBe(true);
  });
});

describe("normaliseDeployStatus", () => {
  it.each([
    ["created", "queued"],
    ["build_in_progress", "building"],
    ["pre_deploy_in_progress", "building"],
    ["update_in_progress", "deploying"],
    ["live", "live"],
    ["deactivated", "live"],
    ["build_failed", "failed"],
    ["update_failed", "failed"],
    ["canceled", "cancelled"],
    [undefined, "building"],
  ])("%s → %s", (status, expected) => {
    expect(normaliseDeployStatus(status)).toBe(expected);
  });
});

describe("log mapping", () => {
  it("keeps build and app lines, drops request logs and blanks, maps errors to stderr", () => {
    const lines = toLogLines({
      logs: [
        { id: "a", message: "==> Running build command\n", timestamp: "2026-11-03T10:00:00Z", labels: [{ name: "type", value: "build" }] },
        { id: "b", message: "boom", timestamp: "2026-11-03T10:00:01Z", labels: [{ name: "type", value: "app" }, { name: "level", value: "error" }] },
        { id: "c", message: "GET /health 200", timestamp: "2026-11-03T10:00:02Z", labels: [{ name: "type", value: "request" }] },
        { id: "d", message: "  ", timestamp: "2026-11-03T10:00:03Z" },
      ],
    });
    expect(lines).toEqual([
      { id: "a", at: Date.parse("2026-11-03T10:00:00Z"), stream: "stdout", text: "==> Running build command" },
      { id: "b", at: Date.parse("2026-11-03T10:00:01Z"), stream: "stderr", text: "boom" },
    ]);
  });

  it("ignores malformed bodies", () => {
    expect(toLogLines(null)).toEqual([]);
    expect(toLogLines({ logs: "nope" })).toEqual([]);
    expect(toLogLine({ id: "x" })).toBeNull();
  });
});

describe("error hints", () => {
  it("explains the usual Render failures from the log", () => {
    expect(hintFor(["building…", "==> No open ports detected, continuing to scan..."])).toMatch(/process\.env\.PORT/);
    expect(hintFor(["fatal: could not read the repository"])).toMatch(/Connect Render to GitHub/);
    expect(hintFor(["Error: Cannot find module '/opt/render/project/src/dist/main'"])).toMatch(/module is missing/);
    expect(hintFor(["all good"])).toBeNull();
  });

  it("describes the failing stage", () => {
    expect(describeFailure("update_failed")).toMatch(/did not start/);
    expect(describeFailure("build_failed")).toMatch(/build failed/);
  });

  it("accepts only an https onrender.com origin", () => {
    expect(safeServiceUrl("https://shop-api.onrender.com/x")).toBe("https://shop-api.onrender.com");
    expect(safeServiceUrl("http://shop-api.onrender.com")).toBeNull();
    expect(safeServiceUrl("https://evil.com")).toBeNull();
    expect(safeServiceUrl("https://a:b@x.onrender.com")).toBeNull();
    expect(safeServiceUrl(undefined)).toBeNull();
  });
});
