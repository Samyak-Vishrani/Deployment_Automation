import { describe, it, expect, vi } from "vitest";
import type { GitHubTreeEntry } from "@/lib/github/github.service";
import {
  detectComponents,
  getRequiredConfigFiles,
  MAX_CONFIG_FILES,
} from "@/lib/analysis/detection.service";

// ---------------------------------------------------------------------------
// Fixtures: a repository is a map of path -> content. Files the detector only
// checks for presence (lockfiles, framework configs) can be left empty.
// ---------------------------------------------------------------------------

type Repo = Record<string, string>;

const pkg = (body: Record<string, unknown>) => JSON.stringify(body);

function treeOf(repo: Repo): GitHubTreeEntry[] {
  return Object.keys(repo).map((path) => ({ path, mode: "100644", type: "blob", sha: "x" }));
}

/** Runs detection over a fixture repo, recording which files were read. */
async function detect(repo: Repo) {
  const fetchContent = vi.fn(async (path: string) => {
    if (!(path in repo)) throw new Error(`404 ${path}`);
    return repo[path];
  });
  const result = await detectComponents(treeOf(repo), fetchContent);
  return { ...result, fetchContent };
}

const NEXT = pkg({
  dependencies: { next: "^14.0.0", react: "^18.0.0" },
  devDependencies: { typescript: "^5.0.0" },
  scripts: { dev: "next dev", build: "next build", start: "next start" },
});
const NEST = pkg({
  dependencies: { "@nestjs/core": "^10.0.0" },
  scripts: { build: "nest build", start: "nest start", "start:prod": "node dist/main" },
});
const EXPRESS = pkg({ dependencies: { express: "^4.18.0" }, scripts: { start: "node server.js" } });

describe("getRequiredConfigFiles", () => {
  it("extracts config files from a tree", () => {
    const tree: GitHubTreeEntry[] = [
      { path: "package.json", mode: "100644", type: "blob", sha: "a" },
      { path: "src/index.ts", mode: "100644", type: "blob", sha: "b" },
      { path: "apps/api/go.mod", mode: "100644", type: "blob", sha: "c" },
      { path: "Dockerfile", mode: "100644", type: "blob", sha: "d" },
      { path: "src", mode: "040000", type: "tree", sha: "e" },
    ];

    const result = getRequiredConfigFiles(tree);

    expect(result).toContain("package.json");
    expect(result).toContain("apps/api/go.mod");
    expect(result).toContain("Dockerfile");
    expect(result).not.toContain("src/index.ts");
    expect(result).not.toContain("src");
  });

  it("returns empty array for tree with no config files", () => {
    expect(getRequiredConfigFiles(treeOf({ "src/index.ts": "", "README.md": "" }))).toEqual([]);
  });

  it("matches suffixed Dockerfiles and leaves ignored folders out", () => {
    const result = getRequiredConfigFiles(
      treeOf({
        "Dockerfile.prod": "",
        "Dockerfile.dockerignore": "",
        ".dockerignore": "",
        "examples/demo/package.json": "",
        "node_modules/x/package.json": "",
        ".devcontainer/Dockerfile": "",
      }),
    );

    expect(result).toEqual(["Dockerfile.prod"]);
  });
});

describe("detectComponents — frameworks", () => {
  it("detects a Next.js project with its build settings", async () => {
    const { components } = await detect({ "package.json": NEXT });

    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      type: "web",
      role: "frontend",
      framework: "nextjs",
      language: "typescript",
      path: ".",
      packageManager: "npm",
      detectedVersion: "14.0.0",
      confidence: 0.95,
      installCmd: "npm install",
      buildCmd: "npm run build",
      startCmd: "npm start",
      outputDir: ".next",
    });
    expect(components[0].evidence).toContain("package.json: next@^14.0.0");
  });

  it("raises confidence when the framework config file is present", async () => {
    const { components } = await detect({ "package.json": NEXT, "next.config.mjs": "" });

    expect(components[0].confidence).toBe(0.98);
    expect(components[0].evidence).toContain("next.config.mjs");
  });

  it("detects a framework from its config file when the dependency is missing", async () => {
    const { components } = await detect({
      "web/package.json": pkg({ scripts: { build: "next build" } }),
      "web/next.config.js": "",
    });

    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ framework: "nextjs", path: "web", confidence: 0.7 });
  });

  it("detects a React project (without Next.js)", async () => {
    const { components } = await detect({
      "package.json": pkg({ dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" } }),
    });

    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      type: "web",
      role: "frontend",
      framework: "react",
      language: "javascript",
    });
  });

  it("does not mistake a server that depends on react for a frontend", async () => {
    const { components } = await detect({
      "api/package.json": pkg({
        dependencies: { hono: "^4.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
        scripts: { start: "node dist/index.js", build: "tsc" },
      }),
      "mailer/package.json": pkg({
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", nodemailer: "^6.0.0" },
        scripts: { start: "node dist/index.js" },
      }),
    });

    expect(components.map((c) => [c.path, c.framework, c.role])).toEqual([
      ["api", "hono", "backend"],
      ["mailer", "node", "backend"],
    ]);
  });

  it("uses the bundler to pick the React output directory", async () => {
    const vite = await detect({
      "package.json": pkg({ dependencies: { react: "^18.2.0" }, devDependencies: { vite: "^5.0.0" } }),
    });
    const cra = await detect({
      "package.json": pkg({ dependencies: { react: "^18.2.0", "react-scripts": "5.0.1" } }),
    });

    expect(vite.components[0]).toMatchObject({ framework: "react", outputDir: "dist" });
    expect(cra.components[0]).toMatchObject({ framework: "react", outputDir: "build" });
  });

  it("detects an Express API", async () => {
    const { components } = await detect({
      "server/package.json": pkg({
        dependencies: { express: "^4.18.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
    });

    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      type: "api",
      role: "backend",
      framework: "express",
      language: "typescript",
      path: "server",
      startCmd: "node index.js",
    });
  });

  it("classifies Django as a backend", async () => {
    const { components } = await detect({
      "requirements.txt": "Django>=4.2\ncelery>=5.0\n",
      "manage.py": "",
      "mysite/wsgi.py": "",
    });

    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      type: "api",
      role: "backend",
      framework: "django",
      language: "python",
      packageManager: "pip",
      detectedVersion: "4.2",
      installCmd: "pip install -r requirements.txt",
      startCmd: "gunicorn mysite.wsgi",
    });
  });

  it("detects a Go project from go.mod", async () => {
    const { components } = await detect({
      "go.mod": "module example.com/myapp\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.1\n",
    });

    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      type: "api",
      role: "backend",
      framework: "gin",
      language: "go",
      detectedVersion: "1.21",
      buildCmd: "go build -o app .",
      startCmd: "./app",
    });
  });

  it("reads the Node version from engines, then .nvmrc", async () => {
    const engines = await detect({
      "package.json": pkg({ dependencies: { express: "4" }, engines: { node: ">=20" } }),
      ".nvmrc": "v18.19.0\n",
    });
    const nvmrc = await detect({
      "api/package.json": pkg({ dependencies: { express: "4" } }),
      ".nvmrc": "v18.19.0\n",
    });

    expect(engines.components[0].runtimeVersion).toBe(">=20");
    expect(nvmrc.components[0].runtimeVersion).toBe("18.19.0");
  });
});

describe("detectComponents — folder layouts", () => {
  it("detects frontend/ (Next.js) + backend/ (NestJS)", async () => {
    const { components } = await detect({
      "frontend/package.json": NEXT,
      "backend/package.json": NEST,
      "backend/nest-cli.json": "{}",
    });

    expect(components).toHaveLength(2);
    expect(components.find((c) => c.path === "frontend")).toMatchObject({
      role: "frontend",
      framework: "nextjs",
      outputDir: ".next",
    });
    expect(components.find((c) => c.path === "backend")).toMatchObject({
      role: "backend",
      framework: "nestjs",
      buildCmd: "npm run build",
      startCmd: "npm run start:prod",
    });
  });

  it.each([
    ["web", "api"],
    ["client", "server"],
    ["apps/web", "apps/api"],
  ])("detects %s/ + %s/ whatever the folders are called", async (front, back) => {
    const { components } = await detect({
      [`${front}/package.json`]: NEXT,
      [`${back}/package.json`]: EXPRESS,
    });

    expect(components).toHaveLength(2);
    expect(components.find((c) => c.path === front)?.role).toBe("frontend");
    expect(components.find((c) => c.path === back)?.role).toBe("backend");
  });

  it("detects a single root app", async () => {
    const { components } = await detect({ "package.json": NEXT, "src/app/page.tsx": "" });

    expect(components.map((c) => c.path)).toEqual(["."]);
  });

  it("returns no components for an empty tree", async () => {
    const { components, warnings, database, fetchContent } = await detect({});

    expect(components).toEqual([]);
    expect(warnings).toEqual([]);
    expect(database.detected).toBe(false);
    expect(fetchContent).not.toHaveBeenCalled();
  });
});

describe("detectComponents — package manager", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm", "pnpm install", "pnpm run build", "pnpm start"],
    ["yarn.lock", "yarn", "yarn install", "yarn run build", "yarn start"],
    ["bun.lockb", "bun", "bun install", "bun run build", "bun run start"],
    ["package-lock.json", "npm", "npm install", "npm run build", "npm start"],
  ])("reads %s as %s", async (lockfile, manager, install, build, start) => {
    const { components } = await detect({ "package.json": NEXT, [lockfile]: "" });

    expect(components[0]).toMatchObject({
      packageManager: manager,
      installCmd: install,
      buildCmd: build,
      startCmd: start,
    });
  });

  it("applies the root lockfile to a nested app", async () => {
    const { components } = await detect({
      "pnpm-lock.yaml": "",
      "web/package.json": NEXT,
      "api/package.json": EXPRESS,
    });

    expect(components.map((c) => c.packageManager)).toEqual(["pnpm", "pnpm"]);
    expect(components.find((c) => c.path === "api")?.startCmd).toBe("pnpm start");
  });

  it("prefers an explicit packageManager field over a lockfile", async () => {
    const { components } = await detect({
      "package.json": pkg({ dependencies: { next: "14" }, packageManager: "yarn@4.1.0" }),
      "package-lock.json": "",
    });

    expect(components[0].packageManager).toBe("yarn");
  });
});

describe("detectComponents — noise filtering", () => {
  it("skips examples/, fixtures/, docs/ and test folders, and says so", async () => {
    const { components, warnings, fetchContent } = await detect({
      "package.json": NEXT,
      "examples/basic/package.json": NEXT,
      "test/fixtures/app/package.json": EXPRESS,
      "docs/requirements.txt": "sphinx\n",
      "packages/x/__tests__/package.json": EXPRESS,
    });

    expect(components.map((c) => c.path)).toEqual(["."]);
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "ignored_paths", message: expect.stringContaining("4 config") }),
    );
    expect(fetchContent).toHaveBeenCalledTimes(1);
  });

  it("skips a tooling-only root", async () => {
    const { components } = await detect({
      "package.json": pkg({
        devDependencies: { eslint: "^9.0.0", prettier: "^3.0.0", typescript: "^5.0.0" },
        scripts: { lint: "eslint ." },
      }),
      "web/package.json": NEXT,
    });

    expect(components.map((c) => c.path)).toEqual(["web"]);
  });

  it("skips a workspace root that only orchestrates, even with a dev script", async () => {
    const { components } = await detect({
      "package.json": pkg({
        workspaces: ["apps/*"],
        devDependencies: { turbo: "^2.0.0" },
        scripts: { dev: "turbo dev", build: "turbo build" },
      }),
      "apps/web/package.json": NEXT,
    });

    expect(components.map((c) => c.path)).toEqual(["apps/web"]);
  });

  it("skips a package with dependencies but nothing to start", async () => {
    const { components } = await detect({
      "packages/utils/package.json": pkg({ dependencies: { lodash: "^4.0.0" } }),
    });

    expect(components).toEqual([]);
  });

  it("limits Node candidates to package.json workspaces", async () => {
    const { components, warnings } = await detect({
      "package.json": pkg({ workspaces: ["apps/*"] }),
      "apps/web/package.json": NEXT,
      "apps/api/package.json": EXPRESS,
      "tools/scripts/package.json": EXPRESS,
    });

    expect(components.map((c) => c.path)).toEqual(["apps/api", "apps/web"]);
    expect(warnings).toContainEqual(expect.objectContaining({ code: "outside_workspace" }));
  });

  it("reads workspace globs from pnpm-workspace.yaml", async () => {
    const { components } = await detect({
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  # comment\n  - \"services/**\"\n",
      "pnpm-lock.yaml": "",
      "apps/web/package.json": NEXT,
      "services/core/api/package.json": EXPRESS,
      "sandbox/package.json": EXPRESS,
    });

    expect(components.map((c) => c.path)).toEqual(["apps/web", "services/core/api"]);
  });

  it("does not let a Node workspace hide a Python service", async () => {
    const { components } = await detect({
      "package.json": pkg({ workspaces: ["apps/*"] }),
      "apps/web/package.json": NEXT,
      "ml/requirements.txt": "fastapi==0.110.0\n",
    });

    expect(components.map((c) => c.framework)).toEqual(["fastapi", "nextjs"]);
  });
});

describe("detectComponents — Python manifests", () => {
  it("parses requirements.txt by package name, ignoring comments and options", async () => {
    const { components } = await detect({
      "requirements.txt": [
        "# we moved off django last year",
        "-r base.txt",
        "flask-cors==4.0.0  # not flask itself",
        "uvicorn[standard]>=0.30",
        "FastAPI==0.110.0",
      ].join("\n"),
      "app/main.py": "",
    });

    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      framework: "fastapi",
      detectedVersion: "0.110.0",
      startCmd: "uvicorn app.main:app --host 0.0.0.0 --port $PORT",
    });
  });

  it("parses PEP 621 dependencies from pyproject.toml", async () => {
    const { components } = await detect({
      "pyproject.toml": [
        "[project]",
        'name = "svc"',
        "dependencies = [",
        '  "uvicorn[standard]>=0.30",',
        '  "fastapi>=0.111",',
        "]",
        "",
        "[tool.ruff]",
        "line-length = 100",
      ].join("\n"),
    });

    expect(components[0]).toMatchObject({
      framework: "fastapi",
      detectedVersion: "0.111",
      packageManager: "pip",
      installCmd: "pip install .",
    });
  });

  it("parses Poetry dependencies from pyproject.toml", async () => {
    const { components } = await detect({
      "pyproject.toml": [
        "[tool.poetry]",
        'name = "svc"',
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.12"',
        'flask = "^3.0.2"',
        "",
        "[tool.poetry.group.dev.dependencies]",
        'django = "^5.0"',
      ].join("\n"),
      ".python-version": "3.12.4\n",
    });

    expect(components[0]).toMatchObject({
      framework: "flask",
      detectedVersion: "3.0.2",
      packageManager: "poetry",
      installCmd: "poetry install",
      runtimeVersion: "3.12.4",
    });
  });

  it("parses [packages] from a Pipfile", async () => {
    const { components } = await detect({
      Pipfile: ['[packages]', 'django = "==5.0.1"', "", "[dev-packages]", 'flask = "*"'].join("\n"),
    });

    expect(components[0]).toMatchObject({
      framework: "django",
      detectedVersion: "5.0.1",
      packageManager: "pipenv",
    });
  });

  it("ignores a pyproject.toml that only configures tools", async () => {
    const { components } = await detect({
      "package.json": NEXT,
      "pyproject.toml": "[tool.black]\nline-length = 100\n",
    });

    expect(components.map((c) => c.framework)).toEqual(["nextjs"]);
  });
});

describe("detectComponents — other ecosystems and Docker", () => {
  it("detects a Dockerfile-only repository as one backend component", async () => {
    const { components, fetchContent } = await detect({ Dockerfile: "FROM node:20\n", "index.js": "" });

    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      type: "worker",
      role: "backend",
      framework: "docker",
      path: ".",
      buildCmd: null,
      startCmd: null,
    });
    // Dockerfiles are matched by name, never read.
    expect(fetchContent).not.toHaveBeenCalled();
  });

  it("matches suffixed Dockerfiles, one component per folder", async () => {
    const { components } = await detect({ "svc/Dockerfile.prod": "", "svc/Dockerfile.dev": "" });

    expect(components).toHaveLength(1);
    expect(components[0].evidence).toEqual(["svc/Dockerfile.prod", "svc/Dockerfile.dev"]);
  });

  it("treats a Dockerfile beside an app as evidence, not a second component", async () => {
    const { components } = await detect({ "package.json": NEXT, Dockerfile: "" });

    expect(components).toHaveLength(1);
    expect(components[0].framework).toBe("nextjs");
    expect(components[0].evidence).toContain("Dockerfile");
  });

  it("detects Rust, Spring, Rails and Laravel as low-confidence backends", async () => {
    const { components } = await detect({
      "rust/Cargo.toml": '[package]\nname = "api"\n\n[dependencies]\naxum = "0.7"\n',
      "java/pom.xml": "<artifactId>spring-boot-starter-web</artifactId>",
      "ruby/Gemfile": "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n",
      "php/composer.json": pkg({ require: { "laravel/framework": "^11.0" } }),
    });

    expect(components.map((c) => [c.path, c.framework, c.role, c.confidence])).toEqual([
      ["java", "spring", "backend", 0.6],
      ["php", "laravel", "backend", 0.6],
      ["ruby", "rails", "backend", 0.6],
      ["rust", "axum", "backend", 0.6],
    ]);
    expect(components.find((c) => c.path === "rust")?.startCmd).toBe("./target/release/api");
  });

  it("does not treat a Cargo workspace root as a crate", async () => {
    const { components } = await detect({
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
    });

    expect(components).toEqual([]);
  });
});

describe("detectComponents — robust reading", () => {
  it("turns a failing file read into a warning and keeps going", async () => {
    const fetchContent = vi.fn(async (path: string) => {
      if (path === "api/package.json") throw new Error("403 rate limit exceeded");
      return NEXT;
    });

    const { components, warnings } = await detectComponents(
      treeOf({ "web/package.json": "", "api/package.json": "" }),
      fetchContent,
    );

    expect(components.map((c) => c.path)).toEqual(["web"]);
    expect(warnings).toEqual([
      {
        code: "file_unreadable",
        path: "api/package.json",
        message: "Could not read api/package.json: 403 rate limit exceeded",
      },
    ]);
  });

  it("handles malformed package.json gracefully", async () => {
    const { components, warnings } = await detect({ "package.json": "this is not valid json {{{" });

    expect(components).toEqual([]);
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "invalid_manifest", path: "package.json" }),
    );
  });

  it("caps the number of files read and reports the overflow", async () => {
    const repo: Repo = {};
    for (let i = 0; i < MAX_CONFIG_FILES + 15; i++) {
      repo[`services/s${String(i).padStart(3, "0")}/package.json`] = EXPRESS;
    }

    const { components, warnings, fetchContent } = await detect(repo);

    expect(fetchContent).toHaveBeenCalledTimes(MAX_CONFIG_FILES);
    expect(components).toHaveLength(MAX_CONFIG_FILES);
    expect(warnings).toContainEqual(expect.objectContaining({ code: "too_many_files" }));
  });

  it("reads at most six files at a time", async () => {
    const repo: Repo = {};
    for (let i = 0; i < 30; i++) repo[`s${i}/package.json`] = EXPRESS;

    let inFlight = 0;
    let peak = 0;
    const fetchContent = vi.fn(async (path: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return repo[path];
    });

    const { components } = await detectComponents(treeOf(repo), fetchContent);

    expect(components).toHaveLength(30);
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
  });

  it("skips a config file too large to be one", async () => {
    const tree: GitHubTreeEntry[] = [
      { path: "package.json", mode: "100644", type: "blob", sha: "x", size: 5 * 1024 * 1024 },
    ];
    const fetchContent = vi.fn();

    const { components, warnings } = await detectComponents(tree, fetchContent);

    expect(components).toEqual([]);
    expect(fetchContent).not.toHaveBeenCalled();
    expect(warnings).toContainEqual(expect.objectContaining({ code: "file_too_large" }));
  });
});

describe("detectComponents — database hints", () => {
  it("suggests Neon for a Prisma + Postgres backend", async () => {
    const { database } = await detect({
      "frontend/package.json": NEXT,
      "backend/package.json": pkg({
        dependencies: { express: "^4.18.0", "@prisma/client": "^5.0.0" },
      }),
      "backend/prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
      "backend/.env.example": "DATABASE_URL=\nPORT=4000\n",
    });

    expect(database).toMatchObject({ detected: true, engine: "postgres", suggestNeon: true });
    expect(database.evidence).toEqual(
      expect.arrayContaining([
        "backend/prisma/schema.prisma: provider",
        "backend/.env.example: DATABASE_URL",
        "backend/package.json: @prisma/client",
      ]),
    );
  });

  it("reports no database for a static frontend", async () => {
    const { database } = await detect({ "package.json": NEXT });

    expect(database).toEqual({ detected: false, engine: "unknown", evidence: [], suggestNeon: false });
  });
});
