import { describe, it, expect } from "vitest";
import { deriveBuildSettings } from "@/lib/analysis/build-settings";

const SCRIPTS = { build: "whatever", start: "whatever" };

describe("deriveBuildSettings — Node frontends", () => {
  it("Next.js", () => {
    expect(deriveBuildSettings({ framework: "nextjs", packageManager: "npm", scripts: SCRIPTS })).toEqual({
      installCmd: "npm install",
      buildCmd: "npm run build",
      startCmd: "npm start",
      outputDir: ".next",
    });
  });

  it.each([
    ["vite", "dist"],
    ["vue", "dist"],
    ["astro", "dist"],
    ["sveltekit", "build"],
  ])("%s builds static files into %s", (framework, outputDir) => {
    expect(deriveBuildSettings({ framework, packageManager: "pnpm", scripts: SCRIPTS })).toEqual({
      installCmd: "pnpm install",
      buildCmd: "pnpm run build",
      startCmd: null,
      outputDir,
    });
  });

  it("React: react-scripts builds into build/, Vite into dist/", () => {
    const base = { framework: "react", packageManager: "npm", scripts: SCRIPTS };

    expect(deriveBuildSettings({ ...base, bundler: "react-scripts" }).outputDir).toBe("build");
    expect(deriveBuildSettings({ ...base, bundler: "vite" }).outputDir).toBe("dist");
    expect(deriveBuildSettings(base).startCmd).toBeNull();
  });

  it("Angular builds into dist/<name>", () => {
    expect(
      deriveBuildSettings({ framework: "angular", packageManager: "npm", scripts: SCRIPTS, name: "shop" }),
    ).toMatchObject({ buildCmd: "npm run build", startCmd: null, outputDir: "dist/shop" });
    expect(deriveBuildSettings({ framework: "angular", packageManager: "npm" }).outputDir).toBe("dist");
  });
});

describe("deriveBuildSettings — Node backends", () => {
  it("NestJS starts the compiled output, not `nest start`", () => {
    expect(deriveBuildSettings({ framework: "nestjs", packageManager: "npm", scripts: SCRIPTS })).toEqual({
      installCmd: "npm install",
      buildCmd: "npm run build",
      startCmd: "node dist/main",
      outputDir: null,
    });
  });

  it("NestJS uses the repo's start:prod script when it has one", () => {
    const settings = deriveBuildSettings({
      framework: "nestjs",
      packageManager: "yarn",
      scripts: { ...SCRIPTS, "start:prod": "node dist/src/main" },
    });

    expect(settings.startCmd).toBe("yarn run start:prod");
  });

  it.each(["express", "fastify", "node"])("%s: own scripts win over defaults", (framework) => {
    expect(deriveBuildSettings({ framework, packageManager: "npm", scripts: SCRIPTS })).toEqual({
      installCmd: "npm install",
      buildCmd: "npm run build",
      startCmd: "npm start",
      outputDir: null,
    });
  });

  it.each(["express", "fastify", "node"])("%s: no scripts falls back to node <main>", (framework) => {
    expect(deriveBuildSettings({ framework, packageManager: "npm", main: "src/server.js" })).toEqual({
      installCmd: "npm install",
      buildCmd: null,
      startCmd: "node src/server.js",
      outputDir: null,
    });
    expect(deriveBuildSettings({ framework, packageManager: "npm" }).startCmd).toBe("node index.js");
  });
});

describe("deriveBuildSettings — scripts and package managers", () => {
  it("falls back to the framework CLI when the repo has no build or start script", () => {
    expect(deriveBuildSettings({ framework: "nextjs", packageManager: "npm", scripts: {} })).toMatchObject({
      buildCmd: "npx next build",
      startCmd: "npx next start",
    });
    expect(
      deriveBuildSettings({ framework: "react", packageManager: "npm", bundler: "react-scripts" }).buildCmd,
    ).toBe("npx react-scripts build");
    expect(deriveBuildSettings({ framework: "nestjs", packageManager: "npm" }).buildCmd).toBe(
      "npx nest build",
    );
  });

  it.each([
    ["npm", "npm install", "npm run build", "npm start"],
    ["pnpm", "pnpm install", "pnpm run build", "pnpm start"],
    ["yarn", "yarn install", "yarn run build", "yarn start"],
    ["bun", "bun install", "bun run build", "bun run start"],
  ])("prefixes commands with %s", (packageManager, installCmd, buildCmd, startCmd) => {
    expect(deriveBuildSettings({ framework: "nextjs", packageManager, scripts: SCRIPTS })).toMatchObject({
      installCmd,
      buildCmd,
      startCmd,
    });
  });

  it("defaults to npm when the package manager is unknown", () => {
    expect(deriveBuildSettings({ framework: "express", packageManager: null }).installCmd).toBe(
      "npm install",
    );
  });
});

describe("deriveBuildSettings — other runtimes", () => {
  it("FastAPI", () => {
    expect(
      deriveBuildSettings({ framework: "fastapi", packageManager: "pip", manifest: "requirements.txt" }),
    ).toEqual({
      installCmd: "pip install -r requirements.txt",
      buildCmd: null,
      startCmd: "uvicorn main:app --host 0.0.0.0 --port $PORT",
      outputDir: null,
    });
    expect(
      deriveBuildSettings({ framework: "fastapi", packageManager: "pip", entry: "app.main:app" }).startCmd,
    ).toBe("uvicorn app.main:app --host 0.0.0.0 --port $PORT");
  });

  it("Flask and Django", () => {
    expect(deriveBuildSettings({ framework: "flask", packageManager: "pip" }).startCmd).toBe(
      "gunicorn app:app",
    );
    expect(
      deriveBuildSettings({ framework: "django", packageManager: "pip", entry: "mysite" }).startCmd,
    ).toBe("gunicorn mysite.wsgi");
    expect(deriveBuildSettings({ framework: "django", packageManager: "pip" }).startCmd).toBe(
      "python manage.py runserver 0.0.0.0:$PORT",
    );
  });

  it("installs from whichever Python manifest the repo uses", () => {
    const install = (manifest: string, packageManager: string) =>
      deriveBuildSettings({ framework: "flask", packageManager, manifest }).installCmd;

    expect(install("requirements.txt", "pip")).toBe("pip install -r requirements.txt");
    expect(install("pyproject.toml", "pip")).toBe("pip install .");
    expect(install("pyproject.toml", "poetry")).toBe("poetry install");
    expect(install("Pipfile", "pipenv")).toBe("pipenv install --deploy");
  });

  it.each(["go", "gin", "fiber"])("%s", (framework) => {
    expect(deriveBuildSettings({ framework, packageManager: "go-modules" })).toEqual({
      installCmd: null,
      buildCmd: "go build -o app .",
      startCmd: "./app",
      outputDir: null,
    });
  });

  it("leaves a Docker component alone: the image defines how it runs", () => {
    expect(deriveBuildSettings({ framework: "docker", packageManager: null })).toEqual({
      installCmd: null,
      buildCmd: null,
      startCmd: null,
      outputDir: null,
    });
  });
});
