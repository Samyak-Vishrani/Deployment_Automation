/**
 * Derives install / build / start commands and the output directory for a
 * detected component.
 *
 * Pure: no I/O, so every framework row can be unit-tested from a literal. The
 * result is a proposal - the configure screen (Phase 5) is where a user
 * overrides it.
 *
 * The rule throughout is that the repository's own package.json scripts win.
 * A framework default is only used when the repo does not say otherwise.
 */

export type BuildSettingsInput = {
  framework: string | null;
  /** npm | pnpm | yarn | bun for Node; pip | poetry | pipenv for Python. */
  packageManager: string | null;
  /** package.json "scripts". */
  scripts?: Record<string, string>;
  /** "vite" | "react-scripts" | another bundler. Decides where a React build lands. */
  bundler?: string | null;
  /** package.json "main". */
  main?: string | null;
  /** package.json "name" (Angular output folder) or the Cargo package name. */
  name?: string | null;
  /** File the dependencies were read from: requirements.txt, pyproject.toml, Pipfile. */
  manifest?: string | null;
  /**
   * Python entry point. "module:app" for FastAPI and Flask; the project package
   * (the folder holding wsgi.py) for Django.
   */
  entry?: string | null;
};

export type BuildSettings = {
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  outputDir: string | null;
};

const NONE: BuildSettings = { installCmd: null, buildCmd: null, startCmd: null, outputDir: null };

/** The framework's own build CLI, for a repo with no "build" script. */
const BUILD_CLI: Record<string, string> = {
  nextjs: "next build",
  nuxt: "nuxt build",
  sveltekit: "vite build",
  astro: "astro build",
  angular: "ng build",
  nestjs: "nest build",
  vue: "vite build",
  vite: "vite build",
};

/** React has no build CLI of its own; its bundler does. Others need a script. */
const REACT_BUILD_CLI: Record<string, string> = {
  "react-scripts": "react-scripts build",
  vite: "vite build",
};

/** Frameworks that build to static files and have nothing to start. */
const STATIC_OUTPUT: Record<string, string> = {
  vite: "dist",
  vue: "dist",
  astro: "dist",
  // adapter-static and adapter-node both write here.
  sveltekit: "build",
};

/** `<pm> run <script>`, using the `<pm> start` shorthand where it exists. */
function runScript(pm: string, script: string): string {
  return script === "start" && pm !== "bun" ? `${pm} start` : `${pm} run ${script}`;
}

function nodeSettings(input: BuildSettingsInput): BuildSettings {
  const framework = input.framework ?? "node";
  const pm = input.packageManager ?? "npm";
  const scripts = input.scripts ?? {};
  const has = (script: string) => typeof scripts[script] === "string";

  const installCmd = `${pm} install`;
  const cli = framework === "react" ? REACT_BUILD_CLI[input.bundler ?? ""] : BUILD_CLI[framework];
  const frameworkBuild = has("build") ? runScript(pm, "build") : cli ? `npx ${cli}` : null;

  switch (framework) {
    case "nextjs":
      return {
        installCmd,
        buildCmd: frameworkBuild,
        startCmd: has("start") ? runScript(pm, "start") : "npx next start",
        outputDir: ".next",
      };
    case "nuxt":
      return {
        installCmd,
        buildCmd: frameworkBuild,
        startCmd: has("start") ? runScript(pm, "start") : "node .output/server/index.mjs",
        outputDir: ".output",
      };
    case "react":
      return {
        installCmd,
        buildCmd: frameworkBuild,
        startCmd: null,
        outputDir: input.bundler === "react-scripts" ? "build" : "dist",
      };
    case "angular":
      return {
        installCmd,
        buildCmd: frameworkBuild,
        startCmd: null,
        outputDir: input.name ? `dist/${input.name}` : "dist",
      };
    case "nestjs":
      return {
        installCmd,
        buildCmd: frameworkBuild,
        // Not "start": Nest scaffolds that as `nest start`, which needs the CLI
        // from devDependencies and is not what production should run.
        startCmd: has("start:prod") ? runScript(pm, "start:prod") : "node dist/main",
        outputDir: null,
      };
    default:
      if (Object.hasOwn(STATIC_OUTPUT, framework)) {
        return {
          installCmd,
          buildCmd: frameworkBuild,
          startCmd: null,
          outputDir: STATIC_OUTPUT[framework],
        };
      }
      // express, fastify, plain node
      return {
        installCmd,
        buildCmd: has("build") ? runScript(pm, "build") : null,
        startCmd: has("start") ? runScript(pm, "start") : `node ${input.main || "index.js"}`,
        outputDir: null,
      };
  }
}

function pythonInstall(input: BuildSettingsInput): string {
  if (input.manifest === "Pipfile") return "pipenv install --deploy";
  if (input.manifest === "pyproject.toml") {
    return input.packageManager === "poetry" ? "poetry install" : "pip install .";
  }
  return "pip install -r requirements.txt";
}

function pythonSettings(input: BuildSettingsInput): BuildSettings {
  const installCmd = pythonInstall(input);
  switch (input.framework) {
    case "fastapi":
      return {
        ...NONE,
        installCmd,
        startCmd: `uvicorn ${input.entry || "main:app"} --host 0.0.0.0 --port $PORT`,
      };
    case "flask":
      return { ...NONE, installCmd, startCmd: `gunicorn ${input.entry || "app:app"}` };
    case "django":
      return {
        ...NONE,
        installCmd,
        // Without a wsgi.py to name the project package, fall back to the one
        // command every Django project is guaranteed to have.
        startCmd: input.entry
          ? `gunicorn ${input.entry}.wsgi`
          : "python manage.py runserver 0.0.0.0:$PORT",
      };
    default:
      return { ...NONE, installCmd };
  }
}

export function deriveBuildSettings(input: BuildSettingsInput): BuildSettings {
  switch (input.framework) {
    case "django":
    case "flask":
    case "fastapi":
    case "python":
      return pythonSettings(input);

    case "go":
    case "gin":
    case "fiber":
      return { ...NONE, buildCmd: "go build -o app .", startCmd: "./app" };

    case "rust":
    case "actix":
    case "axum":
    case "rocket":
      return {
        ...NONE,
        buildCmd: "cargo build --release",
        startCmd: input.name ? `./target/release/${input.name}` : null,
      };

    case "rails":
      return {
        ...NONE,
        installCmd: "bundle install",
        startCmd: "bundle exec rails server -b 0.0.0.0 -p $PORT",
      };

    case "laravel":
      return {
        ...NONE,
        installCmd: "composer install --no-dev",
        startCmd: "php artisan serve --host=0.0.0.0 --port=$PORT",
      };

    // The image defines how these build and run; there is nothing to derive.
    case "docker":
    case "spring":
    case "java":
    case "ruby":
    case "php":
    case null:
      return NONE;

    default:
      return nodeSettings(input);
  }
}
