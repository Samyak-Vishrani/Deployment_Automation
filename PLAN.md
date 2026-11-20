# Deployment Platform — MVP Plan

> A developer connects an existing GitHub repository, marks which folder is the frontend and which is
> the backend, and deploys from our dashboard.

**MVP providers (fixed):** Frontend → **Vercel** · Backend → **Render** · Database → **Neon** · Source → **GitHub**
**After the MVP:** users pick providers per component (Netlify, Railway, Fly, Supabase, self-hosted
Docker, …) through the same provider interface.
**Out of scope:** AWS/Azure/GCP, Kubernetes, Terraform, billing, teams/orgs, AI beyond Phase 13.

Legend: ✅ done · 🟡 partial (code exists to reuse or adapt) · ⬜ not started

**Status as of 2026-11-03:** Phases 3–7 done. All migrations are applied (backend, `vercel` and `render`
schemas). Vercel deploys went live on 2026-11-02 and Render on 2026-11-03, both from the
`Vercel_Integration_test` repo: the frontend at `*.vercel.app`, the backend at
`https://vercel-integration-test-backend.onrender.com`, with the health check returning 200. A push
redeployed only the backend. Tests pass: backend 301, `vercel_integration` 96, `render_integration` 113.
Still open for 6 and 7: the API spikes (`npm run spike`, needs real tokens) and the remaining manual
edge-case checks (cancel, restart-resume, broken build, second user, …).

**Phase 8 (Neon + Deploy all) is implemented and tested, but not yet verified live** (2026-11-03,
`Plans/Plans_Remaining/PLAN_PHASE_8.md`). What is in:
- `backend/neondb_integration` (:3004), its own service;
- the plumbing shared by the three integration services, extracted to `backend/integration_common`;
- `DATABASE_URL` / `DATABASE_URL_UNPOOLED` injected into Render, and the backend's URL into Vercel;
- **Deploy all** as a `Release`.

Migrations are applied locally. Tests: backend 335, `integration_common` 37, `vercel_integration` 88,
`render_integration` 96, `neondb_integration` 66, frontend 6. Open: a Neon API key for the spike and
the live end-to-end checks, and a live Vercel + Render redeploy after the refactor.
**Phase 9 (environment variables) is implemented and tested, but not yet verified live** (2026-11-04,
`Plans/Plans_Remaining/PLAN_PHASE_9.md`). What is in:
- an encrypted `EnvVar` table, per component plus a shared set;
- an editor on Configure, with secrets write-only;
- Vercel frontends get their own vars;
- pre-flight counts per-component and system keys.

Migrations are applied locally. Tests: backend 366, `integration_common` 42, `vercel_integration` 97,
`render_integration` 96, `neondb_integration` 66, frontend 9.
**Phase 12 (logs) is implemented and tested, and checked live against the real Render and Vercel
APIs** (2026-11-04, `Plans/Plans_Remaining/PLAN_PHASE_12.md`). Done ahead of 10 and 11 at the
user's request. What is in:
- a new `backend/logs` service (:3005) that owns all log code: structured build logs, race-free
  resumable streams, and live runtime logs;
- runtime logs come through read-only `/log-proxy` routes in the Vercel and Render services;
- a Logs page with one tab per component, so providers are never mixed.

Tests: backend 382, `logs` 39, `integration_common` 47, `vercel_integration` 103,
`render_integration` 102, `neondb_integration` 66, frontend 12.
**Next: verify Phases 8, 9 and 12 in the UI end to end, then Phase 10 (dashboard).**

---

## Progress at a glance

| # | Phase | State | Carried over from `dokploy-style/` |
|---|---|---|---|
| 1 | Foundation | 🟡 | Next.js + NestJS + Prisma + Postgres running; still needs the monorepo layout, `/api` prefix and placeholder pages |
| 2 | Authentication | 🟡 | — |
| 3 | GitHub integration | ✅ | GitHub App JWT → installation token, repo metadata, branch check, webhook HMAC + dedupe |
| 4 | Repository analysis | ✅ | Source fetch (tarball → extract); detection, build settings, DB hints and snapshots added on top |
| 5 | Deployment configuration | ✅ | Migration applied; the configure → pre-flight → Deploy flow drove the live Vercel and Render deploys |
| 6 | Vercel integration | ✅ | Own service (`backend/vercel_integration`); a Next.js subfolder deployed live on `*.vercel.app` (upload fallback); spike pending |
| 7 | Render integration | ✅ | Own service (`backend/render_integration`); an Express subfolder live on `*.onrender.com`, push-to-deploy verified; spike pending |
| 8 | Neon integration | 🟡 | Code complete as its own service (`backend/neondb_integration`), plus Deploy all (`Release`) and `integration_common`; tests pass; needs a Neon key for the spike and the live check |
| 9 | Environment variables | 🟡 | Code complete: sealed `EnvVar` rows per component + shared; editor with write-only secrets, paste `.env`, add from `.env.example`; Render, Vercel (sensitive/encrypted) and Docker get them on the next deploy; tests pass; live check open |
| 10 | Dashboard | 🟡 | Project list, status badges, live `/events` SSE; Deploy all, per-component deploy, release strip (Phase 8) |
| 11 | Deployment history | 🟡 | Per-project history and detail page; component and provider columns (Phase 6); push-to-deploy for Vercel and Render components; `Release` with a per-project number (Phase 8) |
| 12 | Logs | 🟡 | Code complete in `backend/logs` (:3005): structured, resumable build logs per deployment, live runtime logs (Render, Vercel, Docker) via log proxies, Logs page per component; runtime tails checked live; full UI pass open |
| 13 | AI assistant | ⬜ | — |

---

## Architecture

```text
Developer → Next.js dashboard (apps/web) → NestJS API (apps/api, modular monolith)
                                               │
              ┌───────────────┬────────────────┼──────────────┬──────────────┐
              ▼               ▼                ▼              ▼              ▼
           auth           github         repository      deployments    environment
                        (App + OAuth)     (analysis)          │         (encrypted vars)
                                                              ▼
                                                  DeploymentProvider interface
                                                ┌─────────────┼─────────────┐
                                                ▼             ▼             ▼
                                             Vercel         Render      Neon (DatabaseProvider)
```

**Principle:** our platform orchestrates and records the deployment. Vercel and Render do the build
and hosting. We never build user code on our own machine in the MVP.

### Module map (target)

```text
apps/api/src/
├── auth/            users, JWT, guards
├── github/          App auth, OAuth connect, repo listing, webhooks
├── repository/      source fetch + framework detection
├── projects/        project + components (frontend/backend/database)
├── deployments/     orchestration, queue, status state machine, history
├── providers/
│   ├── provider.interface.ts
│   ├── vercel/  render/  neon/
│   └── local-docker/     ← today's executor, parked for post-MVP
├── environment/     encrypted env vars, per component
├── credentials/     encrypted provider API tokens per user
├── logs/            normalised log fetch + SSE
├── events/          app-wide SSE feed
└── ai/              Phase 13
```

---

## Phase 1 — Foundation 🟡

**Goal:** web, API and database running locally in the target layout.

- ✅ Next.js 15 + TypeScript frontend — `dokploy-style/frontend/`
- ✅ NestJS 10 + TypeScript backend — `dokploy-style/backend/`
- ✅ PostgreSQL 16 via Docker Compose (port 5433) — `dokploy-style/docker-compose.yml`
- ✅ Prisma schema + first migration — `dokploy-style/backend/prisma/`
- 🟡 Hardened `main.ts`: raw body for HMAC, CORS methods, 5 MB body limit, shutdown hooks
- ✅ Jest unit tests (24) + e2e script (17 assertions)
- ✅ Git repo, `.gitignore` for `.env` / `*.pem` / data
- ⬜ Restructure into a monorepo (npm workspaces):
  - `dokploy-style/backend` → `apps/api`, `dokploy-style/frontend` → `apps/web`
  - `packages/types` (shared DTO/response types), `packages/config` (tsconfig base)
  - Prisma stays inside `apps/api` for now; split out `packages/database` only when a second consumer shows up
  - `docker/` for compose files, `docs/` for notes, root `README.md`
- ✅ Global `/api` prefix (`app.setGlobalPrefix('api')`, leaving `/api/webhooks/github` reachable)
- 🟡 Placeholder pages: `/login`, `/dashboard`, `/repositories`, `/deployments`, `/settings`
- 🟡 Placeholder API modules: `/api/auth`, `/api/repositories`, `/api/projects` (✅ exists), `/api/deployments` (✅ exists)
- ✅ Upgrade Node 18.18 → 22 LTS (18 is end-of-life)
- 🟡 Rotate the GitHub App private key and delete the `.pem` from disk

**Done when:** `npm run dev` at the root starts both apps and every placeholder page renders.

---

## Phase 2 — Authentication 🟡

**Goal:** users can register, log in, and only see their own data.

- ✅ `User` model: `id, email (unique), passwordHash, name, createdAt`
- 🟡 `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- ⬜ Password hashing with argon2 (or bcrypt)
- 🟡 JWT access token (`@nestjs/jwt` + `passport-jwt`), 15 min, plus a refresh token in an httpOnly cookie
- ⬜ Global `JwtAuthGuard`, with `@Public()` on auth routes and the GitHub webhook
- ✅ Add `userId` to `Project`; scope every query by the current user
- 🟡 Frontend: login/register forms, auth context, redirect to `/login` when unauthenticated
- ✅ Tighten CORS to `credentials: true` for the web origin

**Done when:** two accounts cannot see each other's projects.

---

## Phase 3 — GitHub Integration ✅

**Goal:** a user connects GitHub, sees their repositories and picks one.

Already built (GitHub **App**, installation-scoped):
- ✅ App JWT → installation token with cache — `github/github.service.ts`
- ✅ Resolve the installation for a repo; read metadata (numeric `repoId`, default branch, private flag)
- ✅ Branch-exists check
- ✅ Strict owner/repo URL validation — `github/repo-url.ts`
- ✅ Webhook HMAC verification (constant-time) + delivery dedupe — `webhooks/`
- ✅ Private-key newline normalisation fix (`f868fff`)

Built in the user-facing half (`Plans/Plans_Remaining/PLAN_PHASE_3_Remaining.md`):
- ✅ **Connect GitHub** flow: sign-in uses the GitHub App's own client id/secret with "Request user
  authorization during installation", so one App covers both identity and repo access
  - The existing `GET /api/auth/github` + `/callback` *is* the connect flow; no separate
    `/api/github/connect` routes. An install redirect (`setup_action`, no state of ours) is never
    exchanged; it restarts sign-in with `next=/deploy/new`
- ✅ Tokens stored on the existing `GitHubConnection` (not a new `GithubAccount` model): `accessTokenEnc`,
  `refreshTokenEnc`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, sealed with `crypto/secret-box.ts`
  (key from `ENCRYPTION_KEY`); refreshed one-at-a-time per user; cleared on sign-out and on
  `github_app_authorization.revoked`
- ✅ `GET /api/repositories` → installations and their repos, read live with the user's token
  (`/user/installations/{id}/repositories`, 5 pages per installation, then `truncated`)
- ✅ `GET /api/repositories/:owner/:repo/branches`
- ✅ `POST /api/projects` checks the *user* can read the repo before the App reads it (closes
  cross-user connects of private repos)
- ✅ Frontend: the picker lives in `/deploy/new` (no separate `/repositories` page): search, grouped by
  account, "Install on more repositories", branch dropdown, "Reconnect GitHub", paste-a-URL fallback
- ✅ `installation` / `installation_repositories` webhooks refresh an open picker
- ✅ Manual: update the GitHub App settings (callback URL, user authorization during install,
  Email addresses: read-only, client secret) — see README "GitHub App setup"

**Done when:** a new user connects GitHub and sees their repo list in the dashboard.

---

## Phase 4 — Repository Analysis ✅

**Goal:** find the frontend and backend folders and their frameworks.

- ✅ Source fetch without `git clone`: tarball at an exact SHA, token in a header only —
  `GithubAppService.openSourceTarball`, extraction in `github/source-archive.ts` (shared by the
  deploy executor and the analysis)
- ✅ Windows-safe temp workspace cleanup — `common/fs-utils.ts`
- ✅ Faster first pass: read the tree with `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` plus a
  handful of file reads (`package.json`, …), with no download. Falls back to the tarball when the
  tree comes back truncated. Authenticates with the GitHub App installation token and pins every
  read to the branch's head SHA — `analysis/analysis.service.ts`
- ✅ `analysis/detection.service.ts` + `analysis/build-settings.ts` — pure functions, unit-tested
  with fixture trees:
  - Node: `package.json` dependencies → `next`, `nuxt`, `@sveltejs/kit`, `astro`, `@angular/core`,
    `@nestjs/core`, `react` (+ `vite` / `react-scripts`), `vue`, `vite`, `express`, `fastify`,
    `hono`, `koa`; package manager from the nearest lockfile; Node version from `engines` / `.nvmrc`
  - Config files: `next.config.*`, `vite.config.*`, `nest-cli.json`, `angular.json`
  - Python: `requirements.txt` / `pyproject.toml` / `Pipfile` → `fastapi`, `django`, `flask`
  - Go, plus low-confidence Rust, Spring, Rails and Laravel
  - `Dockerfile` (and `Dockerfile.*`) → a "docker" component on its own, a runtime hint beside an app
  - Output per folder: `{ path, framework, role: frontend|backend|unknown, installCmd, buildCmd,
    startCmd, outputDir, runtimeVersion, confidence, evidence }`
- ✅ Monorepo handling: any depth, minus dependency/build/test/example/docs folders; `package.json`
  `workspaces` and `pnpm-workspace.yaml` globs limit the Node candidates; at most 60 file reads, 6
  at a time, and an unreadable file is a warning rather than a failed run
- ✅ Detect DB usage (`prisma`, `pg`, `typeorm`, `DATABASE_URL` in `.env.example`, …) → suggest
  Neon for Postgres / unknown SQL, never for MongoDB — `analysis/database-hints.ts`
- ✅ `POST /api/projects/:projectId/analyze` → persists an `Analysis` snapshot at a commit SHA
  (last 5 kept; the same SHA returns the existing snapshot unless `?force=1`);
  `GET /api/projects/:projectId/analysis` returns the latest
- ✅ UI: read-only analysis result on the project page (`components/AnalysisPanel.tsx`) — path,
  role, framework, commands, confidence, database suggestion, warnings. Editing path, framework
  and commands is the Phase 5 configure screen, so user edits are stored apart from the
  re-generated analysis.

**Done when:** a repo with `frontend/` (Next.js) + `backend/` (NestJS) is detected correctly. ✅
Overriding the result is delivered by Phase 5.

---

## Phase 5 — Deployment Configuration ✅

**Goal:** the user confirms where each component goes.

Done (`Plans/Plans_Executed/PLAN_PHASE_5.md`). The `202611020001_deployment_configuration`
migration was applied on 2026-11-03, and the configure screen (cards, Save, pre-flight, Deploy)
drove the live Vercel and Render deploys of `Vercel_Integration_test`.

- ✅ Data model: a new `Component` model (`kind`, `name`, `rootDir`, `framework`, install/build/start
  commands, `outputDir`, `nodeVersion`, `provider`, `providerResourceId`, `url`, `status`), unique on
  `(projectId, kind, rootDir)`. It is kept apart from the `ProjectComponent` analysis snapshot, so
  re-analysing never wipes user edits or provider ids. The Docker fields stay on `Project` for the
  `local-docker` path.
- ✅ MVP rule: provider per kind is fixed (frontend→vercel, backend→render, database→neon). It is
  enforced in `lib/components/provider-rules.ts` and stored per component as data, so post-MVP is a
  validator and UI change only.
- ✅ `POST /api/projects` stays as is (repo → project). Components are created in a second step:
  `GET …/components/proposal` maps the latest analysis onto proposed cards, and `PUT …/components`
  saves the confirmed set. `PATCH`/`DELETE …/components/:id` edit or remove one.
- ✅ UI: `/deploy/[projectId]/configure`. It has one card per component, an "Add database (Neon)"
  toggle, Save, a pre-flight panel and a **Deploy** button that stays disabled until pre-flight
  passes. Connecting a repository now lands here, and the project page shows a Components summary.
- ✅ Pre-flight checks (`GET …/preflight`): root dir exists, `.env.example` keys have values, and at
  least one component. The Vercel (Phase 6) and Render (Phase 7) credential checks are real; Neon reports `pending` until Phase 8.

---

## Phase 6 — Vercel Integration ✅

**Goal:** the frontend component deploys to the user's Vercel account.

Built as a **separate service**, `backend/vercel_integration/` (Fastify + Prisma, Postgres schema
`vercel`, port 3002). The backend talks to it with a shared `INTERNAL_SERVICE_TOKEN`; it posts
deploy events back to `/api/internal/provider-events`, HMAC-signed. Details:
`Plans/Plans_Executed/PLAN_PHASE_6.md` and `backend/vercel_integration/README.md`.

- ✅ **Provider** (`vercel_integration/src/vercel/vercel.provider.ts`):
  - `validateCredentials`, `ensureProject`, `deploy`, `getStatus`, `getLogs`, `cancel`,
    `redeploy`, `setEnv`, `destroy`
  - `NormalisedStatus = queued | deploying | building | live | failed | cancelled`
  - No `ProviderRegistry` yet: with one provider it would be a lookup of one entry. Render
    (Phase 7) adds its own service and the backend picks the client by `component.provider`.
- ✅ **Credentials (MVP):** the user pastes a Vercel access token in Settings → Integrations.
  - It is validated with `GET /v2/user` + `/v2/teams`, then stored sealed in the service's
    `VercelCredential` (`userId, tokenEnc, accountId, teamId?`), never in the backend's database.
  - Team picker; the team is locked once a project exists.
  - Vercel OAuth "Integration" comes after the MVP.
- ✅ `VercelProvider`:
  - `ensureProject`: `POST /v11/projects` (framework preset, `rootDirectory`, build/install/output
    overrides; `nodeVersion` via PATCH). Looks up before creating, PATCHes only on changed settings,
    recreates if deleted on Vercel, and suffixes the name on a collision.
  - Git source when Vercel's GitHub app can see the repo: `POST /v13/deployments` +
    `gitSource { type: 'github', repoId, ref, sha }`.
  - **Fallback:** download the commit's tarball, upload only the files Vercel lacks
    (`missing_files` → `POST /v2/files`), and deploy with `files[]`.
  - Turns off Vercel's own deploy-on-push (`gitProviderOptions.createDeployments = "disabled"`)
    so **we** own triggering.
  - `getStatus`: `GET /v13/deployments/:id` (`readyState`) → normalised. `getLogs`:
    `GET /v3/deployments/:id/events`.
- ✅ Provider columns on `Deployment` (`componentId, provider, providerDeploymentId, providerStatus,
  sourceMode, url, inspectorUrl`) instead of a separate `ProviderDeployment` table
- ✅ Poller in the service:
  - per-component queue; polls every 3 s, backing off to 10 s, until terminal (45 min timeout);
  - ordered, persisted, retried event callbacks feed the backend's log writer and the `/events` SSE;
  - resumes after a restart of either service.
- ✅ UI:
  - Settings → Integrations connects Vercel;
  - Configure has a Deploy button per Vercel component;
  - the project page shows each component's live URL with Deploy/Redeploy;
  - the build page links to Vercel and the live site.
- ✅ Push-to-deploy for Vercel components already deployed once (watch path = `rootDir/**`)
- ✅ Migrations applied: backend `202611030001_vercel_provider` and the service's own (2026-11-03)
- ⬜ API spike against a real Vercel account (`npm run spike`), then tighten `isGitAccessError` from the recorded fixtures
  (`src/vercel/__fixtures__/` is still empty)
- ✅ Live check: a Next.js subfolder goes live on `*.vercel.app` (2026-11-02, again 2026-11-03).
  The deploys used the **upload fallback**: Vercel's GitHub app is not installed on the test repo.
  A redeploy reused the same Vercel project and uploaded only the changed file.
- ⬜ Not yet checked live: the git-source path (Vercel's GitHub app installed), a broken build,
  cancel mid-build, restart-resume of either service, a second user (Verification §4 and A9 in
  `PLAN_PHASE_6.md`)

**Done when:** clicking Deploy puts a Next.js subfolder live on a `*.vercel.app` URL, and it shows in our dashboard.

---

## Phase 7 — Render Integration ✅

**Goal:** the backend component deploys to the user's Render account.

Built as a **separate service**, `backend/render_integration/` (Fastify + Prisma, Postgres schema
`render`, port 3003), mirroring the Vercel one with its **own** secrets: the backend calls it with
`RENDER_SERVICE_TOKEN`; it posts deploy events to `/api/internal/provider-events` tagged
`x-orbitops-provider: render` and signed with `RENDER_CALLBACK_SECRET`. Details:
`Plans/Plans_Executed/PLAN_PHASE_7.md` and `backend/render_integration/README.md`.

- ✅ **Credentials:**
  - The user pastes a Render API key in Settings → Integrations. It is validated with
    `GET /v1/owners` and stored sealed in the service's `RenderCredential`.
  - Workspace picker (locked once a service exists).
  - Region and plan defaults for new services: Oregon / Free.
- ✅ `RenderProvider` (`render_integration/src/render/render.provider.ts`):
  - Needs the user's Render account connected to GitHub (no upload fallback). Pre-flight says so,
    and a repo Render cannot read fails with `render_repo_access` and the fix.
  - `ensureService`:
    - `POST /v1/services`: `web_service`, `repo`, `branch`, `rootDir`, runtime from the framework,
      build = install && build, start command, `healthCheckPath`, plan/region from Settings, env
      vars, `autoDeployTrigger: "off"`.
    - PATCHes only changed settings and recreates a service deleted on Render.
  - Env vars: the project's env vars + `NODE_VERSION`, upserted per key only when changed. Keys we
    set before and are gone are deleted; vars added on Render's dashboard are kept.
  - `deploy`: the deploy Render starts on creation is adopted if it builds our SHA, else cancelled.
    Then `POST /v1/services/:id/deploys` with `commitId`.
  - `getStatus`: `GET /v1/services/:id/deploys/:deployId` → normalised
    (`created/queued` → queued, `build_in_progress` → building, `update_in_progress` → deploying,
    `live/deactivated` → live, `*_failed` → failed, `canceled` → cancelled).
  - `getLogs`: `GET /v1/logs?resource=:id&type=build&type=app`, from this deploy's start, paged.
  - `cancel`, `rollback` (Phase 11 hook), `setEnv` (Phase 9 hook), `destroy` (not called).
- ✅ Health: Render's `live` is success. Then `GET <url><healthCheckPath>` is tried for ~90 s (free
  instances cold-start); it is logged and never fails the deploy.
- ✅ Failure hints from the log: no open port (listen on `process.env.PORT`), no repo access,
  missing module, out of memory.
- ✅ Main backend:
  - one integration-service client per provider;
  - `ProviderDeploymentsService` routes by `component.provider`;
  - callbacks are verified with the sender's own secret, and must match the deployment's provider;
  - `Component.healthCheckPath`;
  - pre-flight checks the runtime and start command;
  - push-to-deploy covers Render components.
- ✅ UI:
  - Render card in Settings (API key, workspace, region, plan);
  - **Deploy to Render** and **Health check path** on the Backend card;
  - **Open api** on the project page.
- ✅ Migrations applied: backend `202611030003_render_provider` and the service's
  `202611030002_init` (2026-11-03)
- ⬜ API spike against a real Render account (`npm run spike`); confirm the log labels and the
  repo-access error text (`src/render/__fixtures__/` is still empty)
- ✅ Live check (2026-11-03): the Express `backend/` of `Vercel_Integration_test` went live at
  `https://vercel-integration-test-backend.onrender.com`:
  - the service was created as node / oregon / free with the project's env vars and
    `NODE_VERSION`;
  - the deploy Render started on creation built our SHA, so it was adopted;
  - status went queued → building → live, with Render's build and app logs streamed;
  - the health probe returned HTTP 200.
- ✅ Push-to-deploy: a push (`27e3424`) redeployed only the backend, reusing the same service, and
  the frontend was not redeployed
- ⬜ Not yet checked live: env var echo, a broken start command, cancel mid-build, restart-resume,
  removed GitHub access, the service stopped, a second user (Verification §4 in `PLAN_PHASE_7.md`)

**Done when:** a NestJS subfolder is live on `*.onrender.com`, and status moves through queued → building → live.

---

## Phase 8 — Neon Database + Deploy all 🟡

**Goal:** provision Postgres and pass it to the backend automatically.

Built as a **separate service**, `backend/neondb_integration/` (Fastify + Prisma, Postgres schema
`neon`, port 3004, its own `NEON_SERVICE_TOKEN`). Provisioning is synchronous, so it sends no
callbacks. Details: `Plans/Plans_Remaining/PLAN_PHASE_8.md` and `backend/neondb_integration/README.md`.

- ✅ **Shared plumbing extracted** to `backend/integration_common`, used by all three services:
  - internal auth, secret-box, redact;
  - provider fetch and errors;
  - the callback client, outbox and deploy queue;
  - the event contract and config helpers.

  The old copies are renamed `xxx_*` for review.
- ✅ **Credential:** a Neon API key in Settings.
  - Validated with `GET /users/me` (or `GET /projects` for an organization key), then sealed.
  - Organization picker (locked once a project exists).
  - Region (default `aws-us-west-2`, next to Render) and Postgres version for new projects.
- ✅ **`NeonProvider`:**
  - `POST /projects`, then wait for the project's operations;
  - project, branch, database and role are stored before the wait, so a retry resumes;
  - a project deleted on Neon is recreated empty, with a warning;
  - a failed setup is replaced;
  - connection strings come fresh from `GET /projects/:id/connection_uri` (pooled and direct).
- ✅ **No connection string is stored anywhere** (deliberately, instead of an encrypted env var):
  the backend asks for it per Render deploy and sends `DATABASE_URL` (pooled) and
  `DATABASE_URL_UNPOOLED` (direct) in the request body only.
- ✅ **Orchestration:** **Deploy all** creates a `Release` and runs it as Neon provision → Render
  backend with `DATABASE_URL` → Vercel frontend with the backend's URL.
  - The URL goes under the framework's key, e.g. `NEXT_PUBLIC_API_URL`.
  - Each stage waits for the one before to be live.
  - Restart-safe; cancel.
- ✅ A lone backend deploy provisions the database first. Push redeploys get the same env vars.
- ✅ **Pre-flight:**
  - the Neon account;
  - a Postgres engine;
  - migrations advice: they are the user's, in the build command, with Prisma's
    `directUrl = env("DATABASE_URL_UNPOOLED")`.
- ✅ **UI:**
  - the Neon card in Settings;
  - **Provision on Neon** and **Deploy all** on Configure;
  - the release strip and the database row (● CONNECTED, Open on Neon) on the project page.
- ⬜ API spike against a real Neon account (`npm run spike`). It shows whether `org_id` is
  required, and the exact texts of the limit and locked errors.
- ⬜ Live check: one Deploy all on `Vercel_Integration_test`, with a `/db` route that queries
  Postgres.
- ⬜ Live Vercel + Render redeploy after the `integration_common` refactor. Startup and opening the
  stored credentials were checked.

**Done when:** one Deploy click creates a Neon DB, and the Render backend connects to it with no manual copy-paste.

---

## Phase 9 — Environment Variables 🟡

Code complete and tested (2026-11-04); the live check is open. Details:
`Plans/Plans_Remaining/PLAN_PHASE_9.md`.

- ✅ API lists return keys only, never values; secret redaction in logs; never Docker build args
- ✅ `EnvVar` model (`backend/lib/env/`): `projectId, componentId (NULL = shared), key, valueEnc, isSecret`
  - **Deviation:** no `source` column. System vars (`DATABASE_URL`, the API URL) are never stored;
    they are computed (`system-env.ts`) and shown read-only.
  - **Deviation:** no `target` column. Render and Vercel give every var to both build and runtime,
    and Docker is runtime-only by design.
- ✅ AES-256-GCM at rest for every value (`lib/crypto/secret-box.ts`). Old `Project.envVars` are
  moved to shared rows at startup.
- ✅ Routes: `GET/PUT /api/projects/:id/env` (shared), `PUT …/components/:cid/env`, reveal
  `GET …/env/:key` (non-secrets only, `no-store`), `GET …/components/:cid/env/suggestions`
- ✅ Sync before each deploy:
  - Render: shared + its own + Neon's;
  - Vercel: its own, as sensitive/encrypted, through an in-memory `EnvVault` in `vercel_integration`;
  - Docker: shared.
  - **Decided:** no sync on save. A deployed component shows "Env changed — redeploy to apply"
    (`envRevision`).
- ✅ Pre-fill from `.env.example`, read at the branch head on demand ("Add from .env.example");
  pre-flight counts per-component and system keys
- ✅ UI: an editor per component and for the shared set (`components/EnvEditor.tsx`). Reveal on click
  is for non-secret values only; paste a `.env`; Save & redeploy.
- ⬜ Live check on `Vercel_Integration_test` (see the plan's Verification)

---

## Phase 10 — Deployment Dashboard 🟡

- ✅ Project list with status badges and relative times — `frontend/app/page.tsx`, `components/StatusBadge.tsx`
- ✅ Live updates over the `/events` SSE with no polling — `hooks/useAppEvents.ts`, `events/`
- ✅ Typed `api()` fetch wrapper — `frontend/app/lib/api.ts`
- 🟡 Project page as component cards: a components table with provider, status (Database ● CONNECTED) and URL (Phase 8); cards ⬜
- 🟡 "Latest deployment" summary: the latest release's steps with their status (Phase 8); per component ⬜
- ✅ Deploy all / deploy one component / redeploy buttons (Phases 6–8)
- ✅ Settings page: connected GitHub account + provider credentials (Vercel, Render, Neon)

---

## Phase 11 — Deployment History 🟡

- ✅ `Deployment` model with status, trigger (push/manual/rollback), commit SHA/message/author,
  timings, error message — `prisma/schema.prisma`
- ✅ `GET /projects/:id/deployments` (paged), `GET /deployments/:id`, cancel, rollback
- ✅ Deployment detail page — `frontend/app/deployments/[id]/page.tsx`
- ✅ Push-to-deploy pipeline: webhook → filters (branch, skip-ci, watch paths) → queue — `deployments/push-filter.ts`
- ✅ Add `componentId, provider, providerDeploymentId, url` (Phase 6) and a per-project sequence number (`Release.number`, `#12`, Phase 8)
- ✅ Group one "Deploy" click into a `Release` holding its component deployments (Phase 8: `Release`, `Deployment.releaseId`)
- ✅ Push-to-deploy now triggers provider deploys (per component, with watch paths = the component's `rootDir/**`): ✅ Vercel (Phase 6), ✅ Render (Phase 7, verified live)
- 🟡 Rollback = provider redeploy of the previous successful `providerDeploymentId` / commit (service hooks exist: Vercel `redeploy`, Render `rollback`; no route or UI yet)
- ⬜ History table: `#, component, provider, status, commit, duration`

---

## Phase 12 — Logs 🟡

Code complete (2026-11-04); details in `Plans/Plans_Remaining/PLAN_PHASE_12.md` and
`backend/logs/README.md`. **All log code lives in `backend/logs`** (:3005), one service for logs
as a whole.

- ✅ **Build logs** are structured JSONL per deployment, `{ seq, at, source, phase, stream, text }`.
  - Every line says whether it came from OrbitOps, Vercel, Render, Neon or Docker.
  - Ingest is idempotent (`clientSeq`) and capped at 20 MB; the old `.log` files are still read.
- ✅ **The main backend keeps no log files.** `RemoteLogWriter` batches lines to the service,
  buffers 5000 while it is down, and falls back to its own tail for `logTail`.
- ✅ **SSE `/logs/stream`:** each `entry` carries `id: <seq>`, and a reconnect resumes with
  `Last-Event-ID`. The replay/subscribe race is fixed. Also `?format=entries` and `/logs/download`.
- ✅ **Runtime logs, live and never stored:**
  - Render app and request logs, polled through `render_integration`'s `/log-proxy` (30 reads a
    minute, so a 3 s poll);
  - Vercel function logs, streamed through `vercel_integration`'s `/log-proxy`;
  - the local Docker container (`docker logs --follow`);
  - Neon has none.
  - Limits: 3 per user, and a stream ends after 15 minutes idle or 60 minutes in total.
- ✅ Provider tokens never reach the logs service: `LOGS_PROXY_TOKEN` opens only `/log-proxy`.
- ✅ **UI:**
  - a **Logs** page with one tab per component, each with Build (deployment picker) and Runtime;
  - `LogPane`: source chips, errors tinted and counted with ↑/↓, "Errors only", search, wrap,
    copy, download, Jump to latest;
  - the build page uses it too.
- ✅ Our own orchestration lines (from Phases 6–8) are now tagged `orbitops`.
- ⬜ A full UI pass: Deploy all, then every tab; a broken build; a restart mid-build.

---

## Phase 13 — AI Assistant 🟡 (code complete 2026-11-20; awaits the migration and a live check)

Plan: `Plans/Plans_Remaining/PLAN_PHASE_13.md`. **Model change (decided 2026-11-20):** OpenAI
`gpt-4o-mini` instead of the Claude API, chosen by the user.

- ✅ New service `backend/ai` (:3006, Fastify + Prisma, schema `ai`), the only holder of
  `OPENAI_API_KEY`; on demand only. The Groq demo (`lib/log-analysis`) is retired (`xxx_` files)
  and `groq-sdk` removed
- ✅ Two scopes: **Diagnose with AI** (the whole project: verdict, problems, ordered steps, status
  per component) and **Analyze** one entity (Vercel, Render, Neon, Docker), each with an optional
  question
- ✅ Context built by the backend: settings, last 5 deployments, errors-first log excerpts and
  runtime snapshots (new `backend/logs` routes), pre-flight, latest release, repo analysis, env
  var **keys only**; every secret value scrubbed from the whole bundle
- ✅ The combined, time-ordered timeline exists only inside the prompt
- ✅ Rules as hypotheses, a token budget, strict Structured Outputs, an evidence guard, a filter
  for destructive commands, and a rule-based fallback without a key
- ✅ 20 an hour / 100 a day per user, one at a time per project, a 10-minute cache
- ✅ UI: project page (header, rows, AI section, past analyses), Logs page tab, build page
  ("Ask AI why it failed")
- ⬜ Apply the `ai` migration (Docker Postgres on :5433), set `OPENAI_API_KEY`, run `npm run spike`
  and the manual checks of the plan

---

## Cross-cutting

- ✅ `crypto/secret-box.ts` (AES-256-GCM, versioned key id): GitHub tokens, and env vars since Phase 9 (provider tokens are sealed in each integration service with its own key)
- ✅ Provider HTTP client: retries with backoff on 429/5xx, and error mapping to user-facing messages (`integration_common/src/provider-fetch.ts` since Phase 8; honours `retry-after`, `ratelimit-reset` and `x-ratelimit-reset`)
- ✅ Idempotency: `ensureProject` / `ensureService` / Neon's `ensure` look up before they create; provider resource ids are stored straight away (Phases 6–8)
- 🟡 Contract tests per provider against recorded fixtures (stubbed-`fetch` unit tests exist; fixtures wait on the spikes); one opt-in live smoke test per provider ⬜
- ✅ Extract `integration_common` (internal auth, secret-box, outbox, provider-fetch, …): done with Neon making it three services (Phase 8)
- ✅ Security baseline carried over: no tokens in argv/logs, `shell: false`, strict input validation (`ValidationPipe` whitelist)

---

## Post-MVP

- Provider choice per component: Netlify / Cloudflare Pages (frontend), Railway / Fly.io (backend),
  Supabase / Railway Postgres (database), **self-hosted Docker** (today's `local-docker` executor becomes a provider)
- OAuth integrations for Vercel/Render instead of pasted tokens
- Preview deployments per PR, custom domains, teams, billing

---

## Suggested build order

1 → 2 → 3 → 4 → 5 → 6 (vertical slice: one Next.js repo live on Vercel) → 7 → 8 → 9 → 10/11/12 polish → 13.
Ship a demo after 6, and after 8. **Done through 7; Phase 8 is implemented, pending its live check (2026-11-03).**
