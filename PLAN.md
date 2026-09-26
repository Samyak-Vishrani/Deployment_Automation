# Deployment Platform — MVP Plan

> A developer connects an existing GitHub repository, marks which folder is the frontend and which is
> the backend, and deploys from our dashboard.

**MVP providers (fixed):** Frontend → **Vercel** · Backend → **Render** · Database → **Neon** · Source → **GitHub**
**After the MVP:** users pick providers per component (Netlify, Railway, Fly, Supabase, self-hosted
Docker, …) through the same provider interface.
**Out of scope:** AWS/Azure/GCP, Kubernetes, Terraform, billing, teams/orgs, AI beyond Phase 13.

Legend: ✅ done · 🟡 partial (code exists to reuse or adapt) · ⬜ not started

---

## Progress at a glance

| # | Phase | State | Carried over from `dokploy-style/` |
|---|---|---|---|
| 1 | Foundation | 🟡 | Next.js + NestJS + Prisma + Postgres running; still needs the monorepo layout, `/api` prefix and placeholder pages |
| 2 | Authentication | 🟡 | — |
| 3 | GitHub integration | 🟡 | GitHub App JWT → installation token, repo metadata, branch check, webhook HMAC + dedupe |
| 4 | Repository analysis | 🟡 | Source fetch (tarball → extract) done; detection still to do |
| 5 | Deployment configuration | 🟡 | — |
| 6 | Vercel integration | ⬜ | Queue and status model can be reused |
| 7 | Render integration | ⬜ | — |
| 8 | Neon integration | ⬜ | — |
| 9 | Environment variables | 🟡 | `envVars` column, values never returned by the API, log redaction; no encryption yet |
| 10 | Dashboard | 🟡 | Project list, status badges, live `/events` SSE |
| 11 | Deployment history | 🟡 | Per-project history and detail page; still needs component and provider columns |
| 12 | Logs | 🟡 | Local log file + SSE replay-then-tail; still needs logs pulled from providers |
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

## Phase 3 — GitHub Integration 🟡

**Goal:** a user connects GitHub, sees their repositories and picks one.

Already built (GitHub **App**, installation-scoped):
- ✅ App JWT → installation token with cache — `github/github.service.ts`
- ✅ Resolve the installation for a repo; read metadata (numeric `repoId`, default branch, private flag)
- ✅ Branch-exists check
- ✅ Strict owner/repo URL validation — `github/repo-url.ts`
- ✅ Webhook HMAC verification (constant-time) + delivery dedupe — `webhooks/`
- ✅ Private-key newline normalisation fix (`f868fff`)

To do:
- ⬜ **Connect GitHub** flow: use the App's *user-to-server* OAuth ("Request user authorization during
  installation") so one App covers both identity and repo access, with no separate OAuth App
  - `GET /api/github/connect` → redirect; `GET /api/github/callback` → exchange the code, store the connection
- 🟡 `GithubAccount` model: `id, userId, githubUserId, login, accessTokenEnc, refreshTokenEnc, expiresAt, createdAt`
  — tokens encrypted with AES-256-GCM (shared `crypto/secret-box.ts`, key from `ENCRYPTION_KEY`)
- ⬜ `GET /api/repositories` → the user's installations and their repos (`/user/installations/{id}/repositories`)
- ⬜ `GET /api/repositories/:owner/:repo/branches`
- ⬜ Frontend `/repositories`: list, search, "Install on more repos" link (`installUrl` already exists), select → branch

**Done when:** a new user connects GitHub and sees their repo list in the dashboard.

---

## Phase 4 — Repository Analysis 🟡

**Goal:** find the frontend and backend folders and their frameworks.

- ✅ Source fetch without `git clone`: tarball at an exact SHA, token in a header only —
  `GithubService.openSourceTarball`, extraction in `deployments/deploy-executor.service.ts`
- ✅ Windows-safe temp workspace cleanup — `common/fs-utils.ts`
- ✅ Faster first pass: read the tree with `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` plus a
  handful of file reads (`package.json`, …), with no download. Fall back to the tarball only when needed.
- 🟡 `repository/detectors/` — pure functions, unit-tested with fixture trees:
  - Node: read `package.json` dependencies → `next`, `vite`, `react-scripts`, `@nestjs/core`, `express`, `fastify`
  - Config files: `next.config.*`, `vite.config.*`, `nest-cli.json`
  - Python: `requirements.txt` / `pyproject.toml` → `fastapi`, `django`, `flask`
  - `Dockerfile` present → "docker" runtime hint
  - Output per folder: `{ path, framework, role: frontend|backend|unknown, buildCmd, startCmd, outputDir, nodeVersion, confidence }`
- 🟡 Monorepo handling: scan the root plus first- and second-level folders, and workspace globs
- ⬜ Detect DB usage (`prisma`, `pg`, `typeorm`, `DATABASE_URL` in `.env.example`) → suggest Neon
- 🟡 `POST /api/repositories/:owner/:repo/analyze` → persist an `Analysis` snapshot (at a commit SHA)
- ⬜ UI: analysis result with editable path, framework and commands per component

**Done when:** a repo with `frontend/` (Next.js) + `backend/` (NestJS) is detected correctly, and the user can override it.

---

## Phase 5 — Deployment Configuration 🟡

**Goal:** the user confirms where each component goes.

- 🟡 Data model rework (replaces the Docker-specific `Project` fields):
  - `Project`: `id, userId, name, repoId, repoFullName, branch, installationId, autoDeploy`
  - `Component`: `id, projectId, kind (frontend|backend|database), rootDir, framework, buildCmd,
    startCmd, outputDir, provider (vercel|render|neon), providerResourceId, url, status`
  - Keep the docker fields for the `local-docker` provider only, or move them to a JSON `providerConfig`
- ⬜ MVP rule: provider per kind is fixed (frontend→vercel, backend→render, database→neon). The
  dropdown shows only that option, but it is stored as data so post-MVP is a UI change only.
- 🟡 `POST /api/projects` from an analysis → creates the project + components
- ⬜ UI: configuration screen (Frontend → Vercel, Backend → Render, Database → Neon, **Deploy** button)
- ⬜ Pre-flight checks: provider credential present, required env vars filled, root dir exists

---

## Phase 6 — Vercel Integration ⬜

**Goal:** the frontend component deploys to the user's Vercel account.

- ⬜ **Provider interface** — `providers/provider.interface.ts`:
  ```ts
  interface DeploymentProvider {
    readonly id: 'vercel' | 'render' | 'local-docker';
    validateCredentials(cred): Promise<AccountInfo>;
    ensureResource(component, env): Promise<{ resourceId: string; url?: string }>; // create/update project/service
    deploy(component, commitSha): Promise<{ providerDeploymentId: string; url?: string }>;
    getStatus(providerDeploymentId): Promise<NormalisedStatus>;
    getLogs(providerDeploymentId, since?): Promise<LogLine[]>;
    redeploy(providerDeploymentId): Promise<...>;
    setEnv(resourceId, vars): Promise<void>;
    destroy?(resourceId): Promise<void>;
  }
  ```
  `NormalisedStatus = queued | building | deploying | live | failed | cancelled`
- ⬜ `ProviderRegistry` — pick the implementation by `component.provider`
- ⬜ **Credentials (MVP):** the user pastes a Vercel access token in `/settings` → validated with
  `GET /v2/user` → stored encrypted in `ProviderCredential(userId, provider, tokenEnc, accountId, teamId?)`.
  Vercel OAuth "Integration" comes after the MVP.
- ⬜ `VercelProvider`:
  - `ensureResource`: `POST /v11/projects` with `framework`, `rootDirectory`, build/output overrides
  - Git source: needs the user's Vercel account linked to GitHub (Vercel's GitHub app). Deploy with
    `POST /v13/deployments` + `gitSource { type: 'github', repoId, ref, sha }`.
    **Fallback** if not linked: upload files from our tarball (`POST /v2/files` + `files[]` deployment).
  - Turn off Vercel's own auto-deploy on push (`gitProviderOptions`/ignored build step) so **we** own triggering
  - `getStatus`: `GET /v13/deployments/:id` (`readyState`) → normalised
  - `getLogs`: `GET /v3/deployments/:id/events`
- ⬜ `ProviderDeployment` rows (see Phase 11 model)
- ⬜ Poller: reuse `deployments/deployment-queue.ts` for serialisation; poll status every 3–5 s with
  backoff until terminal, and publish over the existing `/events` SSE

**Done when:** clicking Deploy puts a Next.js subfolder live on a `*.vercel.app` URL, and it shows in our dashboard.

---

## Phase 7 — Render Integration ⬜

**Goal:** the backend component deploys to the user's Render account.

- ⬜ Credential: Render API key in `/settings`, validated with `GET /v1/owners`
- ⬜ `RenderProvider`:
  - Needs the user's Render account linked to GitHub (checked at pre-flight, with a clear error if not)
  - `ensureResource`: `POST /v1/services` (type `web_service`, `repo`, `branch`, `rootDir`,
    `buildCommand`, `startCommand`, runtime `node`, plan `free`, `autoDeploy: no`)
  - `deploy`: `POST /v1/services/:id/deploys` with `commitId`
  - `getStatus`: `GET /v1/services/:id/deploys/:deployId` → normalised
    (`created/build_in_progress/update_in_progress/live/build_failed/update_failed/canceled`)
  - `getLogs`: `GET /v1/logs?resource=:id` (filtered to the deploy window)
  - `setEnv`: `PUT /v1/services/:id/env-vars`
- ⬜ Health: take Render's `live` as success, plus an optional `GET <url>/health` probe

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
- ⬜ AES-256-GCM encryption at rest (shared with GitHub and provider tokens)
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
- ⬜ Add `componentId, provider, providerDeploymentId, url` and a per-project sequence number (`#12`)
- ⬜ Group one "Deploy" click into a `Release` holding its component deployments
- ⬜ Push-to-deploy now triggers provider deploys (per component, with watch paths = the component's `rootDir/**`)
- ⬜ Rollback = provider redeploy of the previous successful `providerDeploymentId` / commit
- ⬜ History table: `#, component, provider, status, commit, duration`

---

## Phase 12 — Logs 🟡

- ✅ Log writer → file + in-process bus, with redaction — `deployments/deployment-logs.service.ts`
- ✅ `GET /deployments/:id/logs` and SSE `/logs/stream`, replay then tail, 15 s heartbeat
- ✅ Frontend log viewer that autoscrolls only when pinned to the bottom
- ⬜ Pull provider logs (`getLogs`) during the poll loop into the same log writer, so the existing
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

- ⬜ `crypto/secret-box.ts` (AES-256-GCM, versioned key id) used by GitHub tokens, provider tokens and env vars
- ⬜ Provider HTTP client: retries with backoff on 429/5xx, and error mapping to user-facing messages (same style as `GithubError`)
- ⬜ Idempotency: `ensureResource` looks up before it creates; store provider resource ids straight away
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
