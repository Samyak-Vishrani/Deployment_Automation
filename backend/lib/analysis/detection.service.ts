/**
 * Deterministic repository detection engine.
 *
 * Inspects a file tree and select configuration files to detect
 * project components (frameworks, languages, runtimes) without AI.
 *
 * Source-agnostic: it is handed a tree and a way to read a file, and does not
 * know whether they come from the GitHub API or an extracted tarball.
 */

import micromatch from "micromatch";
import type { GitHubTreeEntry } from "@/lib/github/github.service";
import { deriveBuildSettings } from "./build-settings";
import {
  detectDatabaseUsage,
  type DatabaseHint,
  type DatabaseHintInput,
} from "./database-hints";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ComponentRole = "frontend" | "backend" | "unknown";

export type DetectedComponent = {
  /** "web" | "api" | "worker". Kept for compatibility; `role` is what routing uses. */
  type: string;
  role: ComponentRole;
  framework: string | null;
  language: string | null;
  path: string;          // relative directory within the repo
  packageManager: string | null;
  detectedVersion: string | null;
  confidence: number;    // 0..1
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  outputDir: string | null;
  /** Node / Python / Go version the repo asks for, as written. */
  runtimeVersion: string | null;
  /** Which files and dependencies triggered the detection. */
  evidence: string[];
};

export type AnalysisWarning = {
  code: string;
  message: string;
  path?: string;
};

export type DetectionResult = {
  components: DetectedComponent[];
  warnings: AnalysisWarning[];
  database: DatabaseHint;
};

type FileContentFetcher = (path: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Limits and tables
// ---------------------------------------------------------------------------

/** Upper bound on file reads per analysis; each one is a GitHub API call. */
export const MAX_CONFIG_FILES = 60;
const READ_CONCURRENCY = 6;
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Folders that hold dependencies, build output, tests or samples - never an
 * app to deploy. A config file anywhere beneath one is not a component.
 */
const IGNORED_SEGMENTS = new Set([
  "node_modules", "vendor", "dist", "build", "out", ".next", "coverage",
  ".git", ".github", ".devcontainer", "__tests__", "__mocks__", "test", "tests", "fixtures",
  "examples", "example", "docs", "samples",
]);

const PYTHON_MANIFESTS = ["requirements.txt", "pyproject.toml", "Pipfile"];
const JVM_MANIFESTS = ["pom.xml", "build.gradle", "build.gradle.kts"];
const MANIFEST_NAMES = new Set([
  "package.json",
  ...PYTHON_MANIFESTS,
  "go.mod",
  "Cargo.toml",
  ...JVM_MANIFESTS,
  "Gemfile",
  "composer.json",
]);
const DOCKERFILE = /^Dockerfile(\..+)?$/;

/** Read alongside a manifest: runtime versions and database evidence. */
const AUXILIARY_NAMES = [
  ".nvmrc",
  ".node-version",
  ".python-version",
  "runtime.txt",
  ".env.example",
  "schema.prisma",
];

/** Nearest lockfile decides the package manager. */
const LOCKFILES: [string, string][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const VITE_CONFIG = /^vite\.config\.(js|cjs|mjs|ts|cts|mts)$/;
/** Create React App and its wrappers all build into build/. */
const REACT_SCRIPTS_TOOLS = ["react-scripts", "@craco/craco", "react-app-rewired"];
const OTHER_BUNDLERS = ["webpack", "parcel", "@rsbuild/core", "@rspack/core"];

type NodeRule = {
  framework: string;
  type: "web" | "api";
  dep: string;
  /** A config file that confirms the framework, or reveals it when the dep is missing. */
  config?: RegExp;
  confidence: number;
};

/** First match wins, so the more specific framework comes first. */
const NODE_RULES: NodeRule[] = [
  { framework: "nextjs", type: "web", dep: "next", config: /^next\.config\.(js|cjs|mjs|ts)$/, confidence: 0.95 },
  { framework: "nuxt", type: "web", dep: "nuxt", confidence: 0.9 },
  { framework: "sveltekit", type: "web", dep: "@sveltejs/kit", confidence: 0.9 },
  { framework: "astro", type: "web", dep: "astro", confidence: 0.9 },
  { framework: "angular", type: "web", dep: "@angular/core", config: /^angular\.json$/, confidence: 0.9 },
  { framework: "nestjs", type: "api", dep: "@nestjs/core", config: /^nest-cli\.json$/, confidence: 0.9 },
  { framework: "react", type: "web", dep: "react", confidence: 0.9 },
  { framework: "vue", type: "web", dep: "vue", confidence: 0.9 },
  { framework: "vite", type: "web", dep: "vite", config: VITE_CONFIG, confidence: 0.8 },
  { framework: "express", type: "api", dep: "express", confidence: 0.85 },
  { framework: "fastify", type: "api", dep: "fastify", confidence: 0.85 },
  { framework: "hono", type: "api", dep: "hono", confidence: 0.85 },
  { framework: "koa", type: "api", dep: "koa", confidence: 0.85 },
];

const FRONTEND_FRAMEWORKS = new Set([
  "nextjs", "react", "vite", "vue", "nuxt", "angular", "sveltekit", "astro", "static",
]);
const BACKEND_FRAMEWORKS = new Set([
  "express", "fastify", "hono", "koa", "nestjs", "node", "django", "flask", "fastapi",
  "go", "gin", "fiber", "rails", "laravel", "spring",
  "rust", "actix", "axum", "rocket", "docker",
]);

export function roleForFramework(framework: string | null): ComponentRole {
  if (!framework) return "unknown";
  if (FRONTEND_FRAMEWORKS.has(framework)) return "frontend";
  if (BACKEND_FRAMEWORKS.has(framework)) return "backend";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Path and parsing helpers
// ---------------------------------------------------------------------------

const EMPTY: ReadonlySet<string> = new Set();

function parentDir(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? "." : filePath.substring(0, lastSlash);
}

function baseName(filePath: string): string {
  return filePath.substring(filePath.lastIndexOf("/") + 1);
}

function joinPath(dir: string, name: string): string {
  return dir === "." ? name : `${dir}/${name}`;
}

/** "apps/web" -> ["apps/web", "apps", "."] */
function selfAndAncestors(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  while (current !== ".") {
    out.push(current);
    current = parentDir(current);
  }
  out.push(".");
  return out;
}

function isIgnoredPath(filePath: string): boolean {
  const segments = filePath.split("/");
  segments.pop();
  return segments.some((segment) => IGNORED_SEGMENTS.has(segment));
}

function extractVersion(semver: string | undefined | null): string | null {
  if (!semver) return null;
  // Strip common prefixes: ^, ~, >= etc.
  const match = semver.match(/(\d+(?:\.\d+)*)/);
  return match ? match[1] : null;
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The string-valued entries of a JSON object field, or {} if it is not one. */
function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") out[key] = entry;
    }
  }
  return out;
}

function firstLine(content: string | undefined): string | null {
  const line = content?.split(/\r?\n/).find((candidate) => candidate.trim() !== "");
  return line ? line.trim() : null;
}

/** Python package names compare case-insensitively, with - _ . interchangeable. */
function normalisePythonName(name: string): string {
  return name.toLowerCase().replace(/[._]+/g, "-");
}

/** One PEP 508 requirement ("Django>=4.2", "uvicorn[standard]==0.30") -> [name, version]. */
function parseRequirement(spec: string): [string, string | null] | null {
  const match = spec.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/);
  if (!match) return null;
  return [normalisePythonName(match[1]), extractVersion(match[2])];
}

function parseRequirementsTxt(content: string): Map<string, string | null> {
  const deps = new Map<string, string | null>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    // Options (-r other.txt, -e ., --index-url ...) are not packages.
    if (!line || line.startsWith("-")) continue;
    const parsed = parseRequirement(line);
    if (parsed && !deps.has(parsed[0])) deps.set(parsed[0], parsed[1]);
  }
  return deps;
}

/**
 * The lines of one TOML table. Deliberately not a TOML parser: the three
 * tables read here are flat, and a dependency for this is not worth carrying.
 */
function tomlSection(content: string, name: string): string[] | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    // The next table header. An array item such as ["a", "b"], ends in a comma.
    if (/^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body;
}

/** `name = "version"` / `name = { version = "..." }` entries of a TOML table. */
function parseTomlDependencyTable(content: string, section: string): Map<string, string | null> {
  const deps = new Map<string, string | null>();
  for (const line of tomlSection(content, section) ?? []) {
    const match = line.match(/^\s*"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=\s*(.+)$/);
    if (!match) continue;
    const name = normalisePythonName(match[1]);
    if (name !== "python" && !deps.has(name)) deps.set(name, extractVersion(match[2]));
  }
  return deps;
}

/** The quoted strings of the array that opens at `from`, up to its closing bracket. */
function readStringArray(text: string, from: number): string[] {
  const items: string[] = [];
  let quote: string | null = null;
  let current = "";
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        items.push(current);
        quote = null;
        current = "";
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "]") {
      break;
    }
  }
  return items;
}

function parsePyproject(content: string): Map<string, string | null> {
  const deps = new Map<string, string | null>();

  // PEP 621: [project] dependencies = ["fastapi>=0.110", ...]
  const project = tomlSection(content, "project")?.join("\n");
  const array = project?.match(/^\s*dependencies\s*=\s*\[/m);
  if (project && array?.index !== undefined) {
    for (const spec of readStringArray(project, array.index + array[0].length)) {
      const parsed = parseRequirement(spec);
      if (parsed && !deps.has(parsed[0])) deps.set(parsed[0], parsed[1]);
    }
  }

  for (const [name, version] of parseTomlDependencyTable(content, "tool.poetry.dependencies")) {
    if (!deps.has(name)) deps.set(name, version);
  }
  return deps;
}

// ---------------------------------------------------------------------------
// Tree scanning
// ---------------------------------------------------------------------------

type TreeScan = {
  manifests: string[];
  dockerfiles: string[];
  /** Config files that were passed over for sitting under an ignored folder. */
  skipped: number;
};

function scanTree(tree: GitHubTreeEntry[]): TreeScan {
  const scan: TreeScan = { manifests: [], dockerfiles: [], skipped: 0 };
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    const name = baseName(entry.path);
    const isManifest = MANIFEST_NAMES.has(name);
    const isDockerfile = DOCKERFILE.test(name) && !name.endsWith(".dockerignore");
    if (!isManifest && !isDockerfile) continue;

    if (isIgnoredPath(entry.path)) {
      scan.skipped++;
    } else if (isManifest) {
      scan.manifests.push(entry.path);
    } else {
      scan.dockerfiles.push(entry.path);
    }
  }
  return scan;
}

/** Files that the detector may read or act on: manifests and Dockerfiles outside ignored folders. */
export function getRequiredConfigFiles(tree: GitHubTreeEntry[]): string[] {
  const scan = scanTree(tree);
  return [...scan.manifests, ...scan.dockerfiles];
}

type Context = {
  /** File names per directory, for presence checks that need no read. */
  filesByDir: Map<string, Set<string>>;
  /** Every file that was read successfully. */
  contents: Map<string, string>;
  warnings: AnalysisWarning[];
  /** True when the root package.json or pnpm-workspace.yaml declares workspaces. */
  hasWorkspaces: boolean;
};

function depthThenPath(a: string, b: string): number {
  return a.split("/").length - b.split("/").length || a.localeCompare(b);
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  });
  await Promise.all(workers);
}

/** Workspace globs from the root package.json and pnpm-workspace.yaml. */
function workspaceGlobs(ctx: Context): string[] {
  const globs: string[] = [];

  const rootPkg = parseJsonObject(ctx.contents.get("package.json") ?? "");
  const workspaces = rootPkg?.workspaces;
  const declared = Array.isArray(workspaces)
    ? workspaces
    : (workspaces as { packages?: unknown } | undefined)?.packages;
  if (Array.isArray(declared)) {
    globs.push(...declared.filter((glob): glob is string => typeof glob === "string"));
  }

  const yaml = ctx.contents.get("pnpm-workspace.yaml");
  if (yaml) {
    const lines = yaml.split(/\r?\n/);
    const start = lines.findIndex((line) => /^packages\s*:/.test(line));
    if (start !== -1) {
      const inline = lines[start].match(/^packages\s*:\s*\[(.*)\]/);
      if (inline) {
        globs.push(...inline[1].split(","));
      } else {
        for (let i = start + 1; i < lines.length; i++) {
          const item = lines[i].match(/^\s*-\s*(.+?)\s*(#.*)?$/);
          if (item) {
            globs.push(item[1]);
          } else if (lines[i].trim() !== "" && !/^\s*#/.test(lines[i])) {
            break; // the next top-level key
          }
        }
      }
    }
  }

  return globs
    .map((glob) => glob.trim().replace(/^["']|["']$/g, "").replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((glob) => glob !== "");
}

// ---------------------------------------------------------------------------
// Detector rules
// ---------------------------------------------------------------------------

function component(
  base: Omit<DetectedComponent, "role" | "installCmd" | "buildCmd" | "startCmd" | "outputDir">,
  settings: ReturnType<typeof deriveBuildSettings>,
): DetectedComponent {
  return {
    ...base,
    role: roleForFramework(base.framework),
    confidence: Math.round(base.confidence * 100) / 100,
    ...settings,
  };
}

function nodePackageManager(
  dir: string,
  pkg: Record<string, unknown>,
  ctx: Context,
): { name: string; evidence: string | null } {
  // Corepack's "packageManager": "pnpm@9.1.0" is an explicit declaration.
  const declared = typeof pkg.packageManager === "string"
    ? pkg.packageManager.match(/^(npm|pnpm|yarn|bun)@/)?.[1]
    : undefined;
  if (declared) return { name: declared, evidence: null };

  for (const candidate of selfAndAncestors(dir)) {
    const names = ctx.filesByDir.get(candidate) ?? EMPTY;
    for (const [lockfile, manager] of LOCKFILES) {
      if (names.has(lockfile)) {
        return { name: manager, evidence: joinPath(candidate, lockfile) };
      }
    }
  }
  return { name: "npm", evidence: null };
}

/** The first of `names` found in `dir` or the repository root, read and trimmed. */
function readVersionFile(dir: string, names: string[], ctx: Context): string | null {
  for (const candidate of dir === "." ? ["."] : [dir, "."]) {
    for (const name of names) {
      const line = firstLine(ctx.contents.get(joinPath(candidate, name)));
      if (line) return line;
    }
  }
  return null;
}

function detectNode(dir: string, ctx: Context, db: DatabaseHintInput): DetectedComponent | null {
  const path = joinPath(dir, "package.json");
  const content = ctx.contents.get(path);
  if (content === undefined) return null;

  const pkg = parseJsonObject(content);
  if (!pkg) {
    ctx.warnings.push({ code: "invalid_manifest", path, message: `${path} is not valid JSON.` });
    return null;
  }

  const deps = {
    ...stringRecord(pkg.dependencies),
    ...stringRecord(pkg.devDependencies),
  };
  const has = (name: string) => Object.hasOwn(deps, name);
  const scripts = stringRecord(pkg.scripts);
  const names = ctx.filesByDir.get(dir) ?? EMPTY;
  const findConfig = (pattern: RegExp | undefined) =>
    pattern ? [...names].find((name) => pattern.test(name)) : undefined;

  db.nodePackages.push({ path, dependencies: Object.keys(deps) });

  const evidence: string[] = [];
  let framework: string;
  let type: string;
  let confidence: number;
  let detectedVersion: string | null = null;

  const bundler = REACT_SCRIPTS_TOOLS.some(has)
    ? "react-scripts"
    : has("vite") || findConfig(VITE_CONFIG)
      ? "vite"
      : (OTHER_BUNDLERS.find(has) ?? null);

  // React only makes a frontend when something bundles it. Servers depend on
  // react too - to render emails, say - and must not be claimed by that rule.
  const byDependency = NODE_RULES.find(
    (rule) => has(rule.dep) && (rule.framework !== "react" || bundler !== null),
  );
  const rule = byDependency ?? NODE_RULES.find((candidate) => findConfig(candidate.config));
  // A workspace root is an orchestrator (turbo, nx, lint tooling), never the
  // app itself, unless it declares a framework of its own.
  const isWorkspaceRoot = dir === "." && ctx.hasWorkspaces;
  const script = ["start", "dev"].find((name) => Object.hasOwn(scripts, name));

  if (rule) {
    framework = rule.framework;
    type = rule.type;
    const config = findConfig(rule.config);
    if (byDependency) {
      evidence.push(`${path}: ${rule.dep}@${deps[rule.dep]}`);
      detectedVersion = extractVersion(deps[rule.dep]);
      confidence = config ? Math.min(0.99, rule.confidence + 0.03) : rule.confidence;
    } else {
      // The config file is there but the dependency is not declared here.
      confidence = 0.7;
    }
    if (config) evidence.push(joinPath(dir, config));
    if (framework === "react") evidence.push(`${path}: ${bundler}`);
  } else if (script && !isWorkspaceRoot) {
    // No framework, but it can be started: a plain Node service.
    framework = "node";
    type = "api";
    confidence = 0.5;
    evidence.push(`${path}: "${script}" script`);
  } else if (has("react") && has("react-dom") && !isWorkspaceRoot) {
    // Renders to the DOM with no bundler in sight. Probably a frontend.
    framework = "react";
    type = "web";
    confidence = 0.6;
    detectedVersion = extractVersion(deps.react);
    evidence.push(`${path}: react@${deps.react}`);
  } else {
    return null;
  }

  const typescript =
    framework === "angular" || framework === "nestjs" || has("typescript") || names.has("tsconfig.json");
  const packageManager = nodePackageManager(dir, pkg, ctx);
  if (packageManager.evidence) evidence.push(packageManager.evidence);

  const engines = stringRecord(pkg.engines).node;
  const runtimeVersion =
    engines?.trim() || readVersionFile(dir, [".nvmrc", ".node-version"], ctx)?.replace(/^v/, "") || null;

  return component(
    {
      type,
      framework,
      language: typescript ? "typescript" : "javascript",
      path: dir,
      packageManager: packageManager.name,
      detectedVersion,
      confidence,
      runtimeVersion,
      evidence,
    },
    deriveBuildSettings({
      framework,
      packageManager: packageManager.name,
      scripts,
      bundler,
      main: typeof pkg.main === "string" ? pkg.main : null,
      // "@scope/web" builds to dist/web.
      name: typeof pkg.name === "string" ? pkg.name.replace(/^@[^/]+\//, "") : null,
    }),
  );
}

/** Where the app object lives, from the files that are actually there. */
function pythonEntry(framework: string, dir: string, ctx: Context): string | null {
  const names = ctx.filesByDir.get(dir) ?? EMPTY;
  const inSubdir = (sub: string, file: string) =>
    ctx.filesByDir.get(joinPath(dir, sub))?.has(file) ?? false;

  if (framework === "django") {
    // The project package is the folder that holds wsgi.py.
    for (const [candidate, files] of ctx.filesByDir) {
      if (candidate !== "." && parentDir(candidate) === dir && files.has("wsgi.py")) {
        return baseName(candidate);
      }
    }
    return null;
  }
  if (framework === "fastapi") {
    if (names.has("main.py")) return "main:app";
    if (inSubdir("app", "main.py")) return "app.main:app";
    if (inSubdir("src", "main.py")) return "src.main:app";
    if (names.has("app.py")) return "app:app";
    return null;
  }
  if (framework === "flask") {
    if (names.has("app.py")) return "app:app";
    if (names.has("wsgi.py")) return "wsgi:app";
    if (names.has("main.py")) return "main:app";
    return null;
  }
  return null;
}

function detectPython(
  dir: string,
  manifests: string[],
  ctx: Context,
  db: DatabaseHintInput,
): DetectedComponent | null {
  const deps = new Map<string, string | null>();
  let manifest: string | null = null;
  let poetry = false;

  // PYTHON_MANIFESTS order is also install-command priority.
  for (const name of PYTHON_MANIFESTS) {
    if (!manifests.includes(name)) continue;
    const content = ctx.contents.get(joinPath(dir, name));
    if (content === undefined) continue;

    const parsed =
      name === "requirements.txt"
        ? parseRequirementsTxt(content)
        : name === "Pipfile"
          ? parseTomlDependencyTable(content, "packages")
          : parsePyproject(content);
    if (parsed.size === 0) continue;

    manifest ??= name;
    if (name === "pyproject.toml" && tomlSection(content, "tool.poetry.dependencies")) {
      poetry = true;
    }
    for (const [dep, version] of parsed) {
      if (!deps.has(dep)) deps.set(dep, version);
    }
  }

  // A pyproject.toml holding only tool configuration (ruff, black) is not an app.
  if (!manifest) return null;
  const path = joinPath(dir, manifest);
  db.pythonPackages.push({ path, dependencies: [...deps.keys()] });

  const known: [string, number][] = [["django", 0.9], ["flask", 0.85], ["fastapi", 0.85]];
  const match = known.find(([name]) => deps.has(name));
  const framework = match?.[0] ?? "python";
  const packageManager =
    manifest === "Pipfile" ? "pipenv" : manifest === "pyproject.toml" && poetry ? "poetry" : "pip";

  const runtime = readVersionFile(dir, [".python-version", "runtime.txt"], ctx);

  return component(
    {
      type: "api",
      framework,
      language: "python",
      path: dir,
      packageManager,
      detectedVersion: match ? (deps.get(framework) ?? null) : null,
      confidence: match?.[1] ?? 0.5,
      // runtime.txt is written "python-3.12.4".
      runtimeVersion: runtime?.replace(/^python-/i, "") ?? null,
      evidence: [match ? `${path}: ${framework}` : path],
    },
    deriveBuildSettings({
      framework,
      packageManager,
      manifest,
      entry: pythonEntry(framework, dir, ctx),
    }),
  );
}

function detectGo(dir: string, ctx: Context): DetectedComponent | null {
  const path = joinPath(dir, "go.mod");
  const content = ctx.contents.get(path);
  if (content === undefined) return null;
  const lowered = content.toLowerCase();

  let framework = "go";
  let confidence = 0.8;
  if (lowered.includes("github.com/gin-gonic/gin")) {
    framework = "gin";
    confidence = 0.9;
  } else if (lowered.includes("github.com/gofiber/fiber")) {
    framework = "fiber";
    confidence = 0.9;
  }

  const goVersion = content.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m)?.[1] ?? null;

  return component(
    {
      type: "api",
      framework,
      language: "go",
      path: dir,
      packageManager: "go-modules",
      detectedVersion: goVersion,
      confidence,
      runtimeVersion: goVersion,
      evidence: [framework === "go" ? path : `${path}: ${framework}`],
    },
    deriveBuildSettings({ framework, packageManager: "go-modules" }),
  );
}

/**
 * Rust, JVM, Ruby and PHP. Minimal on purpose: enough that such a repository
 * yields a component instead of nothing, at a confidence that says "check me".
 */
function detectOther(dir: string, manifests: string[], ctx: Context): DetectedComponent[] {
  const results: DetectedComponent[] = [];
  const read = (name: string) =>
    manifests.includes(name) ? ctx.contents.get(joinPath(dir, name)) : undefined;
  const low = (
    framework: string,
    language: string,
    packageManager: string,
    matched: boolean,
    evidence: string,
    name: string | null = null,
  ) =>
    results.push(
      component(
        {
          type: "api",
          framework,
          language,
          path: dir,
          packageManager,
          detectedVersion: null,
          confidence: matched ? 0.6 : 0.4,
          runtimeVersion: null,
          evidence: [evidence],
        },
        deriveBuildSettings({ framework, packageManager, name }),
      ),
    );

  const cargo = read("Cargo.toml");
  // A Cargo.toml with no [package] is a workspace root, not a crate.
  const cargoPackage = cargo ? tomlSection(cargo, "package") : null;
  if (cargo && cargoPackage) {
    const framework = /^\s*actix-web\b/m.test(cargo)
      ? "actix"
      : /^\s*axum\b/m.test(cargo)
        ? "axum"
        : /^\s*rocket\b/m.test(cargo)
          ? "rocket"
          : "rust";
    const path = joinPath(dir, "Cargo.toml");
    const name = cargoPackage.join("\n").match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    low(framework, "rust", "cargo", framework !== "rust", framework === "rust" ? path : `${path}: ${framework}`, name);
  }

  // One JVM component per folder, however many build files describe it.
  const jvmName = JVM_MANIFESTS.find((name) => read(name) !== undefined);
  if (jvmName) {
    const spring = JVM_MANIFESTS.some((name) => read(name)?.includes("spring-boot"));
    const path = joinPath(dir, jvmName);
    low(
      spring ? "spring" : "java",
      "java",
      jvmName === "pom.xml" ? "maven" : "gradle",
      spring,
      spring ? `${path}: spring-boot` : path,
    );
  }

  const gemfile = read("Gemfile");
  if (gemfile !== undefined) {
    const rails = /^\s*gem\s+["']rails["']/m.test(gemfile);
    const path = joinPath(dir, "Gemfile");
    low(rails ? "rails" : "ruby", "ruby", "bundler", rails, rails ? `${path}: rails` : path);
  }

  const composer = read("composer.json");
  if (composer !== undefined) {
    const required = stringRecord(parseJsonObject(composer)?.require);
    const laravel = Object.hasOwn(required, "laravel/framework");
    const path = joinPath(dir, "composer.json");
    low(laravel ? "laravel" : "php", "php", "composer", laravel, laravel ? `${path}: laravel/framework` : path);
  }

  return results;
}

function dockerComponent(dir: string, dockerfiles: string[]): DetectedComponent {
  return component(
    {
      type: "worker",
      framework: "docker",
      language: null,
      path: dir,
      packageManager: null,
      detectedVersion: null,
      confidence: 0.6,
      runtimeVersion: null,
      evidence: dockerfiles,
    },
    deriveBuildSettings({ framework: "docker", packageManager: null }),
  );
}

// ---------------------------------------------------------------------------
// Main detection orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs the deterministic detection engine on a repository.
 *
 * A file that cannot be read becomes a warning and detection carries on: one
 * 404 or rate-limited request must not cost the whole analysis.
 *
 * @param tree - The full recursive file tree.
 * @param fetchContent - A function that fetches a file's raw content by path.
 */
export async function detectComponents(
  tree: GitHubTreeEntry[],
  fetchContent: FileContentFetcher,
): Promise<DetectionResult> {
  const warnings: AnalysisWarning[] = [];
  const filesByDir = new Map<string, Set<string>>();
  const sizes = new Map<string, number>();
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    const dir = parentDir(entry.path);
    let names = filesByDir.get(dir);
    if (!names) filesByDir.set(dir, (names = new Set()));
    names.add(baseName(entry.path));
    if (entry.size !== undefined) sizes.set(entry.path, entry.size);
  }

  const ctx: Context = { filesByDir, contents: new Map(), warnings, hasWorkspaces: false };

  const attempted = new Set<string>();
  const read = async (path: string): Promise<void> => {
    if (attempted.has(path)) return;
    attempted.add(path);

    if ((sizes.get(path) ?? 0) > MAX_FILE_BYTES) {
      warnings.push({ code: "file_too_large", path, message: `${path} is too large to analyse and was skipped.` });
      return;
    }
    try {
      ctx.contents.set(path, await fetchContent(path));
    } catch (error) {
      const reason = ((error as Error)?.message ?? "unknown error").replace(/\s+/g, " ").slice(0, 200);
      warnings.push({ code: "file_unreadable", path, message: `Could not read ${path}: ${reason}` });
    }
  };

  const scan = scanTree(tree);
  if (scan.skipped > 0) {
    warnings.push({
      code: "ignored_paths",
      message:
        `${scan.skipped} config file(s) under dependency, build, test, example or docs folders were skipped.`,
    });
  }

  // ------------------------------------------------------------ workspaces --
  const rootFiles = filesByDir.get(".") ?? EMPTY;
  await Promise.all(
    ["package.json", "pnpm-workspace.yaml"].filter((name) => rootFiles.has(name)).map(read),
  );
  const globs = workspaceGlobs(ctx);
  ctx.hasWorkspaces = globs.length > 0;

  let manifests = scan.manifests;
  if (ctx.hasWorkspaces) {
    // When the repo declares its packages, only those (and the root) can be
    // Node apps. Other ecosystems are not governed by the workspace file.
    const isNested = (path: string) => baseName(path) === "package.json" && parentDir(path) !== ".";
    const members = new Set(micromatch(manifests.filter(isNested).map(parentDir), globs));
    const kept = manifests.filter((path) => !isNested(path) || members.has(parentDir(path)));
    if (kept.length < manifests.length) {
      warnings.push({
        code: "outside_workspace",
        message: `${manifests.length - kept.length} package.json file(s) outside the declared workspaces were skipped.`,
      });
    }
    manifests = kept;
  }
  manifests = [...manifests].sort(depthThenPath);

  // ----------------------------------------------------------------- reads --
  const manifestDirs = [...new Set(manifests.map(parentDir))];
  const auxiliary: string[] = [];
  for (const dir of new Set([".", ...manifestDirs])) {
    const names = filesByDir.get(dir) ?? EMPTY;
    for (const name of AUXILIARY_NAMES) {
      if (names.has(name)) auxiliary.push(joinPath(dir, name));
    }
    const prismaDir = joinPath(dir, "prisma");
    if (filesByDir.get(prismaDir)?.has("schema.prisma")) {
      auxiliary.push(joinPath(prismaDir, "schema.prisma"));
    }
  }

  // Manifests first and shallowest first, so the cap costs the least.
  const planned = [...new Set([...manifests, ...auxiliary])];
  if (planned.length > MAX_CONFIG_FILES) {
    warnings.push({
      code: "too_many_files",
      message:
        `Only ${MAX_CONFIG_FILES} of ${planned.length} configuration files were read; the deepest folders were not analysed.`,
    });
  }
  await mapLimit(planned.slice(0, MAX_CONFIG_FILES), READ_CONCURRENCY, read);

  // ------------------------------------------------------------- detection --
  const db: DatabaseHintInput = {
    nodePackages: [],
    pythonPackages: [],
    prismaSchemas: [],
    envExamples: [],
  };
  const components: DetectedComponent[] = [];
  const add = (detected: DetectedComponent | null) => {
    if (detected) components.push(detected);
  };

  const namesByDir = new Map<string, string[]>();
  for (const path of manifests) {
    const dir = parentDir(path);
    namesByDir.set(dir, [...(namesByDir.get(dir) ?? []), baseName(path)]);
  }

  for (const [dir, names] of namesByDir) {
    if (names.includes("package.json")) add(detectNode(dir, ctx, db));
    if (names.some((name) => PYTHON_MANIFESTS.includes(name))) add(detectPython(dir, names, ctx, db));
    if (names.includes("go.mod")) add(detectGo(dir, ctx));
    components.push(...detectOther(dir, names, ctx));
  }

  // A Dockerfile is its own component only where nothing more specific was
  // found; next to a detected app it is a runtime hint on that app.
  const dockerfilesByDir = new Map<string, string[]>();
  for (const path of scan.dockerfiles) {
    const dir = parentDir(path);
    dockerfilesByDir.set(dir, [...(dockerfilesByDir.get(dir) ?? []), path]);
  }
  for (const [dir, dockerfiles] of dockerfilesByDir) {
    const siblings = components.filter((candidate) => candidate.path === dir);
    if (siblings.length === 0) {
      components.push(dockerComponent(dir, dockerfiles));
    } else {
      for (const sibling of siblings) sibling.evidence.push(...dockerfiles);
    }
  }

  for (const [path, content] of ctx.contents) {
    const name = baseName(path);
    if (name === "schema.prisma") db.prismaSchemas.push({ path, content });
    if (name === ".env.example") db.envExamples.push({ path, content });
  }

  components.sort((a, b) => depthThenPath(a.path, b.path));

  return { components, warnings, database: detectDatabaseUsage(db) };
}
