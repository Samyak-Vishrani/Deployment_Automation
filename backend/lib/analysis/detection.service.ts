/**
 * Deterministic repository detection engine.
 *
 * Inspects a file tree and select configuration files to detect
 * project components (frameworks, languages, runtimes) without AI.
 *
 * Returns a list of DetectedComponent records ready for persistence.
 */

import type { GitHubTreeEntry } from "@/lib/github/github.service";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DetectedComponent = {
  type: string;          // "web" | "api" | "static" | "database" | "worker"
  framework: string | null;
  language: string | null;
  path: string;          // relative directory within the repo
  packageManager: string | null;
  detectedVersion: string | null;
  confidence: number;    // 0..1
};

// ---------------------------------------------------------------------------
// Internal helpers — config file readers
// ---------------------------------------------------------------------------

type FileContentFetcher = (path: string) => Promise<string>;

/** Files that the detector needs to read from the repo. */
export function getRequiredConfigFiles(tree: GitHubTreeEntry[]): string[] {
  const configPatterns = [
    /^(.*\/)?package\.json$/,
    /^(.*\/)?requirements\.txt$/,
    /^(.*\/)?Pipfile$/,
    /^(.*\/)?pyproject\.toml$/,
    /^(.*\/)?go\.mod$/,
    /^(.*\/)?Cargo\.toml$/,
    /^(.*\/)?pom\.xml$/,
    /^(.*\/)?build\.gradle(\.kts)?$/,
    /^(.*\/)?Gemfile$/,
    /^(.*\/)?composer\.json$/,
    /^(.*\/)?Dockerfile$/,
    /^(.*\/)?docker-compose\.ya?ml$/,
  ];

  const matches: string[] = [];
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    for (const pattern of configPatterns) {
      if (pattern.test(entry.path)) {
        matches.push(entry.path);
        break;
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Detector rules
// ---------------------------------------------------------------------------

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function parentDir(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? "." : filePath.substring(0, lastSlash);
}

function extractVersion(semver: string | undefined): string | null {
  if (!semver) return null;
  // Strip common prefixes: ^, ~, >= etc.
  const match = semver.match(/(\d+(?:\.\d+)*)/);
  return match ? match[1] : null;
}

function detectFromPackageJson(
  path: string,
  content: string,
): DetectedComponent[] {
  const results: DetectedComponent[] = [];

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(content) as PackageJson;
  } catch {
    return results;
  }

  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  const dir = parentDir(path);

  // Next.js
  if (allDeps["next"]) {
    results.push({
      type: "web",
      framework: "nextjs",
      language: allDeps["typescript"] ? "typescript" : "javascript",
      path: dir,
      packageManager: "npm",
      detectedVersion: extractVersion(allDeps["next"]),
      confidence: 0.95,
    });
    return results; // Next.js is definitive enough
  }

  // React (non-Next)
  if (allDeps["react"] && !allDeps["next"]) {
    results.push({
      type: "web",
      framework: "react",
      language: allDeps["typescript"] ? "typescript" : "javascript",
      path: dir,
      packageManager: "npm",
      detectedVersion: extractVersion(allDeps["react"]),
      confidence: 0.9,
    });
    return results;
  }

  // Vue
  if (allDeps["vue"]) {
    results.push({
      type: "web",
      framework: "vue",
      language: allDeps["typescript"] ? "typescript" : "javascript",
      path: dir,
      packageManager: "npm",
      detectedVersion: extractVersion(allDeps["vue"]),
      confidence: 0.9,
    });
    return results;
  }

  // Angular
  if (allDeps["@angular/core"]) {
    results.push({
      type: "web",
      framework: "angular",
      language: "typescript",
      path: dir,
      packageManager: "npm",
      detectedVersion: extractVersion(allDeps["@angular/core"]),
      confidence: 0.9,
    });
    return results;
  }

  // Express / Fastify / NestJS — API components
  if (allDeps["express"]) {
    results.push({
      type: "api",
      framework: "express",
      language: allDeps["typescript"] ? "typescript" : "javascript",
      path: dir,
      packageManager: "npm",
      detectedVersion: extractVersion(allDeps["express"]),
      confidence: 0.85,
    });
    return results;
  }

  if (allDeps["fastify"]) {
    results.push({
      type: "api",
      framework: "fastify",
      language: allDeps["typescript"] ? "typescript" : "javascript",
      path: dir,
      packageManager: "npm",
      detectedVersion: extractVersion(allDeps["fastify"]),
      confidence: 0.85,
    });
    return results;
  }

  if (allDeps["@nestjs/core"]) {
    results.push({
      type: "api",
      framework: "nestjs",
      language: "typescript",
      path: dir,
      packageManager: "npm",
      detectedVersion: extractVersion(allDeps["@nestjs/core"]),
      confidence: 0.9,
    });
    return results;
  }

  // Generic Node.js project with a package.json but no known framework
  if (Object.keys(allDeps).length > 0) {
    results.push({
      type: "api",
      framework: "node",
      language: allDeps["typescript"] ? "typescript" : "javascript",
      path: dir,
      packageManager: "npm",
      detectedVersion: null,
      confidence: 0.5,
    });
  }

  return results;
}

function detectFromRequirementsTxt(
  path: string,
  content: string,
): DetectedComponent[] {
  const dir = parentDir(path);
  const lines = content.toLowerCase();

  let framework: string | null = null;
  let type = "api";
  let version: string | null = null;
  let confidence = 0.7;

  if (lines.includes("django")) {
    framework = "django";
    type = "web";
    confidence = 0.9;
    const match = content.match(/[Dd]jango[>=~!]*(\d+(?:\.\d+)*)/);
    version = match ? match[1] : null;
  } else if (lines.includes("flask")) {
    framework = "flask";
    confidence = 0.85;
    const match = content.match(/[Ff]lask[>=~!]*(\d+(?:\.\d+)*)/);
    version = match ? match[1] : null;
  } else if (lines.includes("fastapi")) {
    framework = "fastapi";
    confidence = 0.85;
    const match = content.match(/[Ff]ast[Aa][Pp][Ii][>=~!]*(\d+(?:\.\d+)*)/);
    version = match ? match[1] : null;
  }

  if (!framework) {
    // Generic Python project
    return [
      {
        type: "api",
        framework: "python",
        language: "python",
        path: dir,
        packageManager: "pip",
        detectedVersion: null,
        confidence: 0.5,
      },
    ];
  }

  return [
    {
      type,
      framework,
      language: "python",
      path: dir,
      packageManager: "pip",
      detectedVersion: version,
      confidence,
    },
  ];
}

function detectFromGoMod(path: string, content: string): DetectedComponent[] {
  const dir = parentDir(path);
  const lines = content.toLowerCase();

  let framework: string | null = "go";
  let confidence = 0.8;

  if (lines.includes("github.com/gin-gonic/gin")) {
    framework = "gin";
    confidence = 0.9;
  } else if (lines.includes("github.com/gofiber/fiber")) {
    framework = "fiber";
    confidence = 0.9;
  }

  // Extract Go version
  const goVersionMatch = content.match(/^go\s+(\d+\.\d+)/m);
  const goVersion = goVersionMatch ? goVersionMatch[1] : null;

  return [
    {
      type: "api",
      framework,
      language: "go",
      path: dir,
      packageManager: "go-modules",
      detectedVersion: goVersion,
      confidence,
    },
  ];
}

function detectFromDockerfile(path: string): DetectedComponent[] {
  const dir = parentDir(path);
  return [
    {
      type: "worker",
      framework: "docker",
      language: null,
      path: dir,
      packageManager: null,
      detectedVersion: null,
      confidence: 0.6,
    },
  ];
}

// ---------------------------------------------------------------------------
// Main detection orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs the deterministic detection engine on a repository.
 *
 * @param tree - The full recursive file tree from GitHub.
 * @param fetchContent - A function that fetches a file's raw content by path.
 * @returns Array of detected components.
 */
export async function detectComponents(
  tree: GitHubTreeEntry[],
  fetchContent: FileContentFetcher,
): Promise<DetectedComponent[]> {
  const configFiles = getRequiredConfigFiles(tree);
  const allComponents: DetectedComponent[] = [];

  // Track which directories we've already detected components in,
  // to avoid duplicate Dockerfile-based detections when a stronger
  // signal (package.json, etc.) already exists.
  const detectedDirs = new Set<string>();

  // Process higher-confidence files first
  const prioritized = [...configFiles].sort((a, b) => {
    const priority = (p: string) => {
      if (p.endsWith("package.json")) return 0;
      if (p.endsWith("requirements.txt") || p.endsWith("Pipfile") || p.endsWith("pyproject.toml")) return 1;
      if (p.endsWith("go.mod")) return 2;
      if (p.endsWith("Dockerfile")) return 10;
      return 5;
    };
    return priority(a) - priority(b);
  });

  for (const configPath of prioritized) {
    const dir = parentDir(configPath);
    const filename = configPath.split("/").pop() ?? configPath;

    let components: DetectedComponent[] = [];

    if (filename === "package.json") {
      const content = await fetchContent(configPath);
      components = detectFromPackageJson(configPath, content);
    } else if (
      filename === "requirements.txt" ||
      filename === "Pipfile" ||
      filename === "pyproject.toml"
    ) {
      const content = await fetchContent(configPath);
      components = detectFromRequirementsTxt(configPath, content);
    } else if (filename === "go.mod") {
      const content = await fetchContent(configPath);
      components = detectFromGoMod(configPath, content);
    } else if (filename === "Dockerfile") {
      // Only add Dockerfile detection if we haven't already detected
      // something more specific in this directory.
      if (!detectedDirs.has(dir)) {
        components = detectFromDockerfile(configPath);
      }
    }

    for (const comp of components) {
      detectedDirs.add(comp.path);
      allComponents.push(comp);
    }
  }

  return allComponents;
}
