# Phase 4 — Repository Analysis: remaining work and bug fixes

> Companion to `PLAN_PHASE_5.md`.

## Context

`PLAN.md` Phase 4 ("find the frontend and backend folders and their frameworks") is 🟡. The
detection engine (`backend/lib/analysis/detection.service.ts`) and the analyze endpoints exist, but:

- **analysis cannot run at all** (auth bug below), so nothing downstream (Phase 5 configuration,
  Phases 6–7 providers) has real input;
- the detector output is missing half of what the plan specifies (`role, buildCmd, startCmd,
  outputDir, nodeVersion`), which Vercel/Render need;
- several correctness bugs produce wrong or noisy components.

**Done when** (from `PLAN.md:165`, generalised): analysing a repo with any folder names — e.g.
`frontend/` (Next.js) + `backend/` (NestJS), `web/` + `api/`, or a single root app — returns one
component per real app with role, commands and output dir; the result is tied to a commit; and the
user can see it in the dashboard. (Editing/overriding the result is delivered by the Phase 5
configure screen — see step 9.)

## Bugs to fix

| # | Bug | Where | Effect |
|---|---|---|---|
| B1 | Authenticates with `GitHubConnection.accessToken`, which GitHub sign-in never stores | `analysis.service.ts:105` | Every analyze call → `400 github_not_connected` |
| B2 | Analyses `defaultBranch`, ignoring the project's `branch` | `analysis.service.ts:117` | Wrong code analysed when a non-default branch is deployed |
| B3 | Tree + file reads use the branch name, not a pinned commit; branch not URL-encoded (`feature/x` breaks `git/trees/feature/x`) | `github.service.ts:46,71` | Inconsistent reads if a push lands mid-analysis; 404 on slashed branches |
| B4 | File paths not URL-encoded in `contents/{path}` | `github.service.ts:77` | Paths with spaces/`#`/`?` fail |
| B5 | `tree.truncated` ignored | `analysis.service.ts` | Large repos silently analysed from a partial tree |
| B6 | One failing file read aborts the whole analysis; reads are sequential and unbounded | `detection.service.ts detectComponents` | A single 404/rate-limit kills the run; 100+ `package.json` = 100+ serial calls |
| B7 | Every config file anywhere becomes a component (`examples/`, `docs/`, test fixtures, a monorepo root with only tooling devDeps → bogus "node api") | `getRequiredConfigFiles` / `detectFromPackageJson` | Noisy, wrong components |
| B8 | Django classified `type: "web"` | `detectFromRequirementsTxt` | Would be routed to Vercel instead of Render |
| B9 | `packageManager` always `"npm"` | `detectFromPackageJson` | Wrong install/build commands for pnpm/yarn repos |
| B10 | `Pipfile` / `pyproject.toml` parsed as `requirements.txt` by substring match | `detectFromRequirementsTxt` | Matches in comments/other packages; versions not extracted |
| B11 | `Cargo.toml`, `pom.xml`, `build.gradle`, `Gemfile`, `composer.json` collected but never handled; `Dockerfile` regex misses `Dockerfile.prod` etc. | `detectComponents` | Wasted reads; those repos yield zero components |
| B12 | Analyze/analysis routes hand-roll auth + errors instead of `requireUser` / `toErrorResponse` | `app/api/projects/[projectId]/analy*/route.ts` | Inconsistent error shape vs the rest of the API |

## Steps

### 1. Analysis auth + pinned commit (B1–B4) — `backend/lib/analysis/analysis.service.ts`, `backend/lib/github/`
- Turn the module into an `AnalysisService` class registered in `backend/lib/runtime.ts`
  (same pattern as `ProjectsService`), taking `prisma` and `GithubAppService`.
- Token: `project.installationId ?? github.resolveInstallationId(repo)` →
  `github.getInstallationToken(id)` (`github-app.service.ts:109,152`). Drop the
  `GitHubConnection` lookup.
- Branch: `project.branch ?? project.defaultBranch`.
- Add `GithubAppService.getBranchHeadSha(repo, branch)` (same `/branches/{branch}` call as
  `branchExists`, returning `commit.sha`). Tree and every file read use that **SHA**.
- In `github.service.ts`: `encodeURIComponent` the ref; encode each path segment
  (`path.split("/").map(encodeURIComponent).join("/")`).
- B12: routes use `requireUser()` + `services().analysis` + `toErrorResponse`; `AnalysisError`
  becomes `HttpError` (`backend/lib/api/http-error.ts`) with the same codes.

### 2. Analysis snapshot tied to a commit — `backend/prisma/schema.prisma`
New migration `…_analysis_snapshot`:
```prisma
enum AnalysisStatus { running succeeded failed }
model Analysis {
  id          String         @id @default(cuid())
  projectId   String
  branch      String
  commitSha   String
  status      AnalysisStatus @default(running)
  source      String         // "tree" | "tarball"
  warnings    Json           @default("[]")   // skipped folders, unreadable files, truncation
  database    Json?                           // step 7
  error       String?        @db.Text
  createdAt   DateTime       @default(now())
  finishedAt  DateTime?
  project     Project            @relation(fields: [projectId], references: [id], onDelete: Cascade)
  components  ProjectComponent[]
  @@index([projectId, createdAt(sort: Desc)])
}
```
- `ProjectComponent` gets `analysisId` (FK, cascade) plus new columns `role`, `buildCmd`,
  `startCmd`, `installCmd`, `outputDir`, `runtimeVersion`, `evidence Json` (which files/deps
  triggered it). Existing rows: backfill-free — old rows get `analysisId = null`; new runs
  always set it.
- Each run creates a new `Analysis`; keep the last 5 per project, delete older (cascade removes
  their components). `getProjectAnalysis` returns the latest **succeeded** one.
- Re-analysing the same `commitSha` returns the existing snapshot unless `?force=1`.

### 3. Tarball fallback for truncated trees (B5) — new `backend/lib/github/source-archive.ts`
- Extract the download + `gunzip` + `tar.extract({ strip: 1 })` block from
  `DeployExecutor.fetchAndBuild` (`deploy-executor.service.ts:~185`) into
  `downloadSource(github, repo, ref, installationId, destDir)`; the executor calls it (no
  behaviour change).
- When `tree.truncated`: download to a temp dir under `resolveDataDir()/analysis/<id>`, build
  a `GitHubTreeEntry[]` by walking it, read files from disk; always `removeDir`
  (`backend/lib/common/fs-utils.ts`) in `finally`. Record `source: "tarball"`.
- Detection stays source-agnostic: it only takes `tree` + `fetchContent`.

### 4. Robust reading (B6) — `detection.service.ts`
- Read files with a concurrency limit of 6 and a cap of 60 config files per analysis
  (overflow → warning).
- Per-file failure → warning `{ path, reason }`, detection continues. Only tree/commit
  failures fail the run.

### 5. Noise filtering + workspaces (B7) — `detection.service.ts`
- Ignore any path with a segment in: `node_modules, vendor, dist, build, out, .next, coverage,
  .git, .github, __tests__, __mocks__, test, tests, fixtures, examples, example, docs, samples`.
  Report the number skipped as a warning.
- Workspaces: read root `package.json` `workspaces` (array or `{ packages }`) and
  `pnpm-workspace.yaml` `packages`; when present, only folders matching those globs (via
  `micromatch`, already a backend dependency) plus the root are candidates.
- Root `package.json` becomes a component only if it has a framework dependency or a
  `start`/`dev` script — tooling-only roots (turbo, eslint, prettier) are skipped.

### 6. Detector upgrade (B8–B11, missing output fields) — `detection.service.ts` + new `backend/lib/analysis/build-settings.ts`
Extend `DetectedComponent` with
`role: "frontend" | "backend" | "unknown"`, `buildCmd, startCmd, installCmd, outputDir,
runtimeVersion, evidence: string[]`. Keep `type` for compatibility.
- **Role map**: next, react, vite, vue, nuxt, angular, sveltekit, astro, static → frontend;
  express, fastify, nestjs, node, django, flask, fastapi, go/gin/fiber, rails, laravel, spring,
  rust → backend; docker → backend. Fixes B8.
- **Node**: add `vite`, `react-scripts` (output `build`), `nuxt`, `@sveltejs/kit`, `astro`.
  Config files `next.config.*`, `vite.config.*`, `nest-cli.json`, `angular.json` confirm/raise
  confidence and detect when deps are missing. Package manager from sibling-or-root lockfile
  (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `package-lock.json`) — fixes B9. Node version
  from `engines.node`, `.nvmrc`, `.node-version`.
- **Python**: real parsers — `requirements.txt` line-by-line package names (ignore comments),
  `pyproject.toml` `[project].dependencies` / `[tool.poetry.dependencies]`, `Pipfile [packages]`
  (regex over the relevant section; no TOML dependency). Version from `.python-version` /
  `runtime.txt`. Fixes B10.
- **Other languages (B11)**: minimal detectors → backend, low confidence: `Cargo.toml` (actix/
  axum), `pom.xml`/`build.gradle` (spring-boot), `Gemfile` (rails), `composer.json` (laravel).
  Dockerfile regex → `Dockerfile(\..+)?`.
- **`build-settings.ts`** (pure): `deriveBuildSettings(component, pkgScripts, pm)` — prefer the
  repo's own `scripts.build`/`scripts.start`, else framework defaults:
  | framework | install | build | start | output |
  |---|---|---|---|---|
  | next | `<pm> install` | `<pm> run build` | `<pm> start` | `.next` |
  | vite / vue / sveltekit / astro | `<pm> install` | `<pm> run build` | — | `dist` |
  | react-scripts | `<pm> install` | `<pm> run build` | — | `build` |
  | angular | `<pm> install` | `<pm> run build` | — | `dist/<name>` |
  | nestjs | `<pm> install` | `<pm> run build` | `node dist/main` | — |
  | express / fastify / node | `<pm> install` | script if any | `<pm> start` or `node <main>` | — |
  | fastapi | `pip install -r requirements.txt` | — | `uvicorn main:app --host 0.0.0.0 --port $PORT` | — |
  | flask / django | same | — | `gunicorn app:app` / `gunicorn <project>.wsgi` | — |
  | go | — | `go build -o app .` | `./app` | — |
  (`PLAN_PHASE_5.md` step 3 then just consumes this — see step 9.)

### 7. Database usage detection → suggest Neon — new `backend/lib/analysis/database-hints.ts` (pure)
Evidence sources (from files already read, plus `prisma/schema.prisma` and `.env.example` added
to the config-file list):
- Node deps: `@prisma/client`/`prisma`, `pg`, `postgres`, `typeorm`, `sequelize`, `drizzle-orm`,
  `knex`, `mysql2`, `mongoose`/`mongodb`.
- Python: `psycopg`/`psycopg2`, `asyncpg`, `sqlalchemy`, `django` (settings default sqlite).
- `schema.prisma` `provider = "postgresql" | "mysql" | …`; `DATABASE_URL` in `.env.example`.

Output stored on `Analysis.database`:
`{ detected, engine: "postgres"|"mysql"|"mongodb"|"sqlite"|"unknown", evidence: string[], suggestNeon }`
— `suggestNeon` only for postgres/unknown SQL, never for MongoDB.

### 8. Analysis UI (read-only) — `frontend/app/(dashboard)/deploy/[projectId]/page.tsx`
- `frontend/lib/deploy/types.ts` + `client.ts`: `ProjectAnalysis` type, `analyzeProject(id)`,
  `getProjectAnalysis(id)` using the existing `withSession` pattern.
- New `frontend/components/AnalysisPanel.tsx` on the project page: "Analyze repository" /
  "Re-analyze" button, commit + time, one row per component (path, role badge, framework,
  commands, output dir, confidence), database suggestion callout, warnings list (skipped folders,
  unreadable files, truncated tree).
- `deploy/new/page.tsx`: trigger analysis right after the project is created.

### 9. Align docs
- `PLAN_PHASE_5.md`: step 2 (analysis auth) and step 3 (build settings) now point to this plan;
  its configure screen is where overrides happen.
- `PLAN.md`: tick the Phase 4 items as they land; `frontend/docs/API_CONTRACT.md`: analysis
  response shape.

## Out of scope
Editing/overriding detected components (Phase 5 configure screen), Neon provisioning (Phase 8),
Dockerfile generation (post-MVP).

## Verification
1. `cd backend && npx prisma migrate dev && npm run typecheck && npm run lint && npm test`.
2. Unit tests (vitest, fixture trees + fake `fetchContent`):
   - `detection.service.test.ts`: `web/`+`api/`, `client/`+`server/`, root-only app; pnpm/yarn
     lockfiles; vite vs react-scripts output dirs; examples/ and fixtures/ skipped; workspace
     globs; tooling-only root skipped; Django → backend; pyproject/Pipfile parsing; one failing
     file read → warning not failure.
   - `build-settings.test.ts`: table above, own scripts win over defaults.
   - `database-hints.test.ts`: prisma postgres → suggestNeon; mongoose → no Neon.
   - `analysis.service.test.ts`: installation token used (no `GitHubConnection`), project branch
     used, commit SHA pinned, truncated tree → tarball path, same SHA reuses snapshot, keeps last 5.
   - `github.service` tests: slashed branch and spaced path are encoded.
3. Manual (backend + frontend running, GitHub App installed on the test repos):
   - Monorepo with `frontend/` (Next.js) + `backend/` (NestJS) → two components, correct roles,
     `.next` output, `node dist/main` start, Neon suggested if Prisma/pg present.
   - Repo with `web/` + `api/` and a pnpm lockfile → `pnpm` commands.
   - The existing `Github_Webhook_Test_2` repo (Dockerfile only) → one backend `docker` component.
   - Push a new commit, re-analyze → new snapshot with the new SHA; re-analyze again → reused.
   - Existing push-to-deploy still works (executor now uses `source-archive.ts`).
