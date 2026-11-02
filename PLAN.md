# Deployment Platform — MVP Plan

> A developer connects an existing GitHub repository, marks which folder is the frontend and which is
> the backend, and deploys from our dashboard.

**MVP providers (fixed):** Frontend → **Vercel** · Backend → **Render** · Database → **Neon** · Source → **GitHub**
**After the MVP:** users pick providers per component (Netlify, Railway, Fly, Supabase, self-hosted
Docker, …) through the same provider interface.
**Out of scope:** AWS/Azure/GCP, Kubernetes, Terraform, billing, teams/orgs, AI beyond Phase 13.

Legend: ✅ done · 🟡 partial (code exists to reuse or adapt) · ⬜ not started

**Status as of 2026-11-03:** Phases 3–6 done (Vercel deploys verified live on 2026-11-02). Phase 7 code is complete (`Plans/Plans_Remaining/PLAN_PHASE_7.md`): Render is a separate service in `backend/render_integration`. It needs its secrets, its migrations applied, Render connected to GitHub, the API spike and a live deploy check.

---

## Progress at a glance

| # | Phase | State | Carried over from `dokploy-style/` |
|---|---|---|---|
| 1 | Foundation | 🟡 | Next.js + NestJS + Prisma + Postgres running; still needs the monorepo layout, `/api` prefix and placeholder pages |
| 2 | Authentication | 🟡 | — |
| 3 | GitHub integration | ✅ | GitHub App JWT → installation token, repo metadata, branch check, webhook HMAC + dedupe |
| 4 | Repository analysis | ✅ | Source fetch (tarball → extract); detection, build settings, DB hints and snapshots added on top |
| 5 | Deployment configuration | 🟡 | Code complete; migration not applied and the manual checks not yet run |
| 6 | Vercel integration | ✅ | Own service (`backend/vercel_integration`); a Next.js subfolder deployed live on `*.vercel.app` |
| 7 | Render integration | 🟡 | Code complete as its own service (`backend/render_integration`); needs secrets, migrations, the API spike and a live check |
| 8 | Neon integration | ⬜ | — |
| 9 | Environment variables | 🟡 | `envVars` column, values never returned by the API, log redaction; encryption helper (`secret-box.ts`) exists but env vars are not encrypted yet |
| 10 | Dashboard | 🟡 | Project list, status badges, live `/events` SSE |
| 11 | Deployment history | 🟡 | Per-project history and detail page; component and provider columns added in Phase 6 |
| 12 | Logs | 🟡 | Local log file + SSE replay-then-tail; Vercel build logs relayed into it since Phase 6 |
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

## Phase 5 — Deployment Configuration 🟡

**Goal:** the user confirms where each component goes.

Code complete (`Plans/Plans_Remaining/PLAN_PHASE_5.md`). Before this phase is ✅, the
`202611020001_deployment_configuration` migration has to be applied and the manual checks in that
plan run against a real repo.

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
`Plans/Plans_Remaining/PLAN_PHASE_6.md` and `backend/vercel_integration/README.md`.

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
- ⬜ API spike against a real Vercel account (`npm run spike`), then tighten `isGitAccessError` from the recorded fixtures
- ✅ Live check: a Next.js subfolder goes live on `*.vercel.app` (2026-11-02)

**Done when:** clicking Deploy puts a Next.js subfolder live on a `*.vercel.app` URL, and it shows in our dashboard.

---

## Phase 7 — Render Integration 🟡

**Goal:** the backend component deploys to the user's Render account.

Built as a **separate service**, `backend/render_integration/` (Fastify + Prisma, Postgres schema
`render`, port 3003), mirroring the Vercel one with its **own** secrets: the backend calls it with
`RENDER_SERVICE_TOKEN`; it posts deploy events to `/api/internal/provider-events` tagged
`x-orbitops-provider: render` and signed with `RENDER_CALLBACK_SECRET`. Details:
`Plans/Plans_Remaining/PLAN_PHASE_7.md` and `backend/render_integration/README.md`.

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
- ⬜ API spike against a real Render account (`npm run spike`); confirm the log labels and the
  repo-access error text
- ⬜ Live check: a NestJS/Express subfolder goes live on `*.onrender.com`

**Done when:** a NestJS subfolder is live on `*.onrender.com`, and status moves through queued → building → live.

---

## Phase 8 — Neon Database ⬜

**Goal:** provision Postgres and pass it to the backend automatically.

- ⬜ `DatabaseProvider` interface: `provision(project) → { resourceId, connectionUri }`, `getStatus`, `destroy`
- ⬜ Credential: Neon API key in `/settings`, validated with `GET /api/v2/users/me`
- ⬜ `NeonProvider.provision`: `POST /api/v2/projects` → take the pooled connection URI from the response
  (or `GET /projects/:id/connection_uri`)
- ⬜ Store `DATABASE_URL` as an **encrypted, system-managed** env var on the backend component
- ⬜ Orchestration order in `DeploymentsService.deployProject()`:
  `Neon provision (idempotent) → set DATABASE_URL on Render → deploy backend → deploy frontend (with NEXT_PUBLIC_API_URL = backend url)`
- ⬜ Optional: run migrations as part of the backend build command (documented, set by the user)

**Done when:** one Deploy click creates a Neon DB, and the Render backend connects to it with no manual copy-paste.

---

## Phase 9 — Environment Variables 🟡

- ✅ `envVars` stored per project; the API returns keys only, never values — `projects/projects.service.ts`
- ✅ Secret redaction in logs — `common/redact.ts`
- ✅ Never passed as build args (documented in schema)
- ⬜ `EnvVar` model per component: `key, valueEnc, isSecret, source (user|system), target (build|runtime|both)`
- 🟡 AES-256-GCM encryption at rest (shared with GitHub and provider tokens)
- ⬜ `GET/PUT /api/projects/:id/components/:cid/env` — values masked, write-only secrets
- ⬜ Sync to the provider on save and before each deploy (`setEnv`)
- ⬜ Pre-fill keys from `.env.example` found during analysis
- ⬜ UI: key/value editor per component, reveal-on-click only for non-secret values

---

## Phase 10 — Deployment Dashboard 🟡

- ✅ Project list with status badges and relative times — `frontend/app/page.tsx`, `components/StatusBadge.tsx`
- ✅ Live updates over the `/events` SSE with no polling — `hooks/useAppEvents.ts`, `events/`
- ✅ Typed `api()` fetch wrapper — `frontend/app/lib/api.ts`
- ⬜ Project page as component cards: Frontend (Vercel, ● LIVE, URL), Backend (Render, ● LIVE, URL),
  Database (Neon, ● CONNECTED)
- ⬜ "Latest deployment" summary row per component
- ⬜ Deploy all / deploy one component / redeploy buttons
- ⬜ Settings page: connected GitHub account + provider credentials

---

## Phase 11 — Deployment History 🟡

- ✅ `Deployment` model with status, trigger (push/manual/rollback), commit SHA/message/author,
  timings, error message — `prisma/schema.prisma`
- ✅ `GET /projects/:id/deployments` (paged), `GET /deployments/:id`, cancel, rollback
- ✅ Deployment detail page — `frontend/app/deployments/[id]/page.tsx`
- ✅ Push-to-deploy pipeline: webhook → filters (branch, skip-ci, watch paths) → queue — `deployments/push-filter.ts`
- 🟡 Add `componentId, provider, providerDeploymentId, url` (✅ Phase 6) and a per-project sequence number (`#12`)
- ⬜ Group one "Deploy" click into a `Release` holding its component deployments
- 🟡 Push-to-deploy now triggers provider deploys (per component, with watch paths = the component's `rootDir/**`): ✅ Vercel (Phase 6)
- ⬜ Rollback = provider redeploy of the previous successful `providerDeploymentId` / commit
- ⬜ History table: `#, component, provider, status, commit, duration`

---

## Phase 12 — Logs 🟡

- ✅ Log writer → file + in-process bus, with redaction — `deployments/deployment-logs.service.ts`
- ✅ `GET /deployments/:id/logs` and SSE `/logs/stream`, replay then tail, 15 s heartbeat
- ✅ Frontend log viewer that autoscrolls only when pinned to the bottom
- 🟡 Pull provider logs (`getLogs`) during the poll loop into the same log writer (✅ Vercel, Phase 6), so the existing
  SSE + viewer work unchanged
- ⬜ Add our own orchestration lines (`==> Provisioning Neon`, `==> Deploying to Render`)
- 🟡 Highlight error lines, and a "copy log" button

---

## Phase 13 — AI Assistant ⬜ (only after 6–12 are reliable)

- ⬜ `ai/` module using the Claude API (`claude-sonnet-5` by default)
- ⬜ `POST /api/deployments/:id/ask` — context: provider, framework, status, last ~500 log lines,
  env var **keys only** (never values), analysis result
- ⬜ System prompt: diagnose, cite log lines, suggest a concrete fix; never invent env values
- ⬜ UI: "Ask AI" on failed deployments, with a streamed answer
- ⬜ Rate limit per user; redact again before sending

---

## Cross-cutting

- ✅ `crypto/secret-box.ts` (AES-256-GCM, versioned key id) — used by GitHub tokens today; provider tokens and env vars next
- ✅ Provider HTTP client: retries with backoff on 429/5xx, and error mapping to user-facing messages (`vercel_integration/src/http/`, Phase 6)
- ✅ Idempotency: `ensureProject` looks up before it creates; provider resource ids are stored straight away (Phase 6)
- ⬜ Contract tests per provider against recorded fixtures; one opt-in live smoke test per provider
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
Ship a demo after 6, and after 8.
