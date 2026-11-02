import { describe, expect, it } from "vitest";
import type { ComponentSpec } from "../types";
import { vercelFramework } from "./framework-map";
import { toLogLine, toLogLines } from "./log-map";
import { vercelProjectName } from "./project-name";
import { settingsHash, toProjectSettings, vercelNodeVersion } from "./project-settings";
import { normaliseReadyState } from "./status-map";
import { productionUrl } from "./vercel.provider";

const component = (overrides: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id: "c1",
  name: "web",
  rootDir: "frontend",
  framework: "nextjs",
  installCmd: "npm install",
  buildCmd: "npm run build",
  outputDir: ".next",
  nodeVersion: "20",
  ...overrides,
});

describe("vercelFramework", () => {
  it.each([
    ["nextjs", null, "nextjs"],
    ["nuxt", null, "nuxtjs"],
    ["sveltekit", null, "sveltekit-1"],
    ["vite", "dist", "vite"],
    ["react", "build", "create-react-app"],
    ["react", "dist", "vite"],
    ["express", null, null],
    [null, null, null],
  ])("%s (output %s) → %s", (framework, outputDir, expected) => {
    expect(vercelFramework(framework, outputDir)).toBe(expected);
  });
});

describe("toProjectSettings", () => {
  it("leaves the output folder to Vercel's Next.js builder", () => {
    const settings = toProjectSettings(component());
    expect(settings).toEqual({
      framework: "nextjs",
      rootDirectory: "frontend",
      installCommand: "npm install",
      buildCommand: "npm run build",
      outputDirectory: null,
      nodeVersion: "20.x",
    });
  });

  it("keeps the output folder for static frameworks and maps the root to null", () => {
    const settings = toProjectSettings(component({ framework: "vite", rootDir: ".", outputDir: "dist" }));
    expect(settings.rootDirectory).toBeNull();
    expect(settings.outputDirectory).toBe("dist");
  });

  it("treats blank commands as Vercel's defaults", () => {
    const settings = toProjectSettings(component({ installCmd: "  ", buildCmd: null }));
    expect(settings.installCommand).toBeNull();
    expect(settings.buildCommand).toBeNull();
  });

  it("hashes stably and changes when a setting changes", () => {
    const a = settingsHash(toProjectSettings(component()));
    expect(settingsHash(toProjectSettings(component()))).toBe(a);
    expect(settingsHash(toProjectSettings(component({ buildCmd: "pnpm build" })))).not.toBe(a);
  });
});

describe("vercelNodeVersion", () => {
  it.each([
    ["20", "20.x"],
    [">=22.0.0", "22.x"],
    ["v18.17.1", "18.x"],
    ["16", null],
    [null, null],
  ])("%s → %s", (input, expected) => {
    expect(vercelNodeVersion(input)).toBe(expected);
  });
});

describe("vercelProjectName", () => {
  it("joins repo and component as a DNS-safe slug", () => {
    expect(vercelProjectName("Samyak/My_App", "Web Frontend")).toBe("my-app-web-frontend");
  });

  it("does not repeat a component named like the repo", () => {
    expect(vercelProjectName("me/shop", "shop")).toBe("shop");
  });

  it("appends a suffix and stays within 100 characters", () => {
    const name = vercelProjectName(`me/${"a".repeat(150)}`, "web", "x1y2");
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith("-x1y2")).toBe(true);
    expect(name).not.toMatch(/--/);
  });
});

describe("normaliseReadyState", () => {
  it.each([
    ["QUEUED", "queued"],
    ["INITIALIZING", "building"],
    ["BUILDING", "building"],
    ["READY", "live"],
    ["ERROR", "failed"],
    ["CANCELED", "cancelled"],
    [undefined, "building"],
  ])("%s → %s", (state, expected) => {
    expect(normaliseReadyState(state)).toBe(expected);
  });
});

describe("log mapping", () => {
  it("reads both event shapes and drops noise", () => {
    const lines = toLogLines([
      { type: "command", created: 1, payload: { text: "npm run build", id: "a" } },
      { type: "stdout", created: 2, payload: { text: "compiled\n", id: "b" } },
      { type: "stderr", created: 3, text: "warn", id: "c" },
      { type: "delimiter", created: 4, payload: { text: "---", id: "d" } },
      { type: "stdout", created: 5, payload: { text: "   ", id: "e" } },
    ]);
    expect(lines).toEqual([
      { id: "a", at: 1, stream: "info", text: "$ npm run build" },
      { id: "b", at: 2, stream: "stdout", text: "compiled" },
      { id: "c", at: 3, stream: "stderr", text: "warn" },
    ]);
  });

  it("ignores a non-array body", () => {
    expect(toLogLines({ error: "x" })).toEqual([]);
    expect(toLogLine({ type: "stdout" })).toBeNull();
  });
});

describe("productionUrl", () => {
  it("prefers <project>.vercel.app, then the shortest vercel.app alias", () => {
    expect(productionUrl(["web-git-main-me.vercel.app", "web.vercel.app"], "web")).toBe("https://web.vercel.app");
    expect(productionUrl(["web-me-long.vercel.app", "web-me.vercel.app"], "other")).toBe("https://web-me.vercel.app");
    expect(productionUrl([], "web", "web-abc123.vercel.app")).toBe("https://web-abc123.vercel.app");
  });
});
