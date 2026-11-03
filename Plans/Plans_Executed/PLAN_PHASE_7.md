# Phase 7 — Render Integration: implementation plan

> Companion to `PLAN_PHASE_6.md`.
>
> **Status: done and verified live (2026-11-03).** All Render code is in
> `backend/render_integration/`, plus the seam listed below.
>
> | Item | State |
> |---|---|
> | Steps 1–9 (service, seam, frontend, docs) | ✅ implemented |
> | Step 0, the API spike (`npm run spike`, needs a real Render API key) | ⬜ not run; `src/render/__fixtures__/` is empty |
> | Migrations `202611030003_render_provider` (backend) and `202611030002_init` (`render` schema) | ✅ applied 2026-11-03 |
> | Verification §1, build hygiene | ✅ `render_integration` 113 tests, backend 301 tests, `vercel_integration` 96 tests, all passing (typecheck clean) |
> | Verification §2–3, unit and backend tests | ✅ passing |
> | Verification §4, manual | 🟡 the core path passed; the edge cases are not run yet (list below) |
>
> Verification §4, checked live on 2026-11-03 with `Robert-547/Vercel_Integration_test`:
> - ✅ Settings: key saved and the workspace listed (the deploy ran under it).
> - ✅ Configure: Backend card pre-flight passed; **Deploy to Render** enabled.
> - ✅ Deploy (`4419089`, manual):
>   - created `vercel-integration-test-backend` (node, oregon, free, 2 env vars,
>     `NODE_VERSION=20`);
>   - adopted the deploy Render started on creation, because it built our SHA;
>   - streamed Render's build and app log;
>   - status queued → building → live;
>   - health probe `GET /` → HTTP 200;
>   - live at `https://vercel-integration-test-backend.onrender.com`.
> - ✅ Push-to-deploy (`27e3424`, trigger `push`): only the backend redeployed, on the same service.
>   No Vercel deploy was created for that commit.
> - ✅ Vercel deploys still work: the frontend went live from the same commit (`4419089`).
> - ⬜ Not checked yet:
>   - env var echo (`GREETING=hi`), and that the value never appears in our log;
>   - a broken start command → failed, with the hint;
>   - cancel mid-build;
>   - restart `render_integration` mid-build → resume;
>   - removed GitHub access → `render_repo_access`;
>   - the service stopped → "Unavailable";
>   - a second user → 404.
>
> Where the code departs from the text below, and why:
> - **Only `autoDeployTrigger: "off"` is sent**, not also the older `autoDeploy: "no"`. Sending both
>   risks a 400 if Render rejects the combination; the teammate's earlier code used
>   `autoDeployTrigger` alone. The spike confirms it.
> - **`PYTHON_VERSION` is set only from a fully specified version** (`3.12.4`), because Render
>   needs one; `NODE_VERSION` takes a major.
> - **The Render API key is sent as `{ token }`** to the backend's credential route, the same as the
>   Vercel token, so one Settings form handles both. The backend forwards it to the service as
>   `{ apiKey }`.
> - **Logs start at the deploy request's time**, so a reused service's older logs are not replayed.
> - **Pre-flight's Render framework list** (`RENDER_FRAMEWORKS` in `lib/components/provider-rules.ts`)
>   mirrors the service's `runtime-map.ts`, which stays the source of truth at deploy time.
> - **Migrations:** `backend/prisma/migrations/202611030003_render_provider` (adds
>   `Component.healthCheckPath`) and `render_integration/prisma/migrations/202611030002_init`.

## Context

`PLAN.md` Phase 7 ("the backend component deploys to the user's Render account") is the second
provider. Phase 6 (Vercel) is done and live. It built a pattern this phase reuses wholesale:
- an **integration service** per provider (`backend/vercel_integration`, Fastify + Prisma, its own
  Postgres schema);
- a thin **seam in the main backend** (`lib/providers/*`, credential proxy routes, signed callbacks
  into `/api/internal/provider-events`);
- **Deployment rows**, logs and the `/events` feed owned by the main backend.

An earlier Render attempt by a teammate (`d9ceb32`, reverted in `7c8c606`) lived inside the main
backend. It is used here only as prior art for Render API details (`autoDeployTrigger: "off"`,
runtime/region/plan values, `deactivated` = live).

**Done when:** on `/deploy/<id>/configure`, clicking **Deploy to Render** on the Backend card puts
an Express/NestJS subfolder live on `*.onrender.com`:
- status moves queued → building → deploying → live, and the build page streams Render's log;
- the project page shows the component **Live** with its URL and an **Open api** button;
- a push touching only `backend/` redeploys the backend and not the frontend.

### Decisions made with the user
1. **New service `backend/render_integration`** on **:3003**, schema `render`, mirroring
   `vercel_integration`. Vercel's service is not touched.
2. **Shared plumbing is copied**, as Vercel did. Extract `integration_common` when Neon (Phase 8)
   makes it three services.
3. **Env vars:** the project's existing env vars (`Project.envVars`) are sent to Render on create
   and before every deploy, upserted per key, never logged. Phase 9 later swaps the source for
   encrypted per-component vars.
4. **Region and plan are workspace defaults in Settings** (Oregon / Free), applied when a service is
   created. Render fixes both after creation.

---

## Constraint: all Render code in `backend/render_integration/`, as its own microservice

**Every line of Render-specific code goes in a new folder, `backend/render_integration/`, which
runs as a separate microservice.** It is its own process with its own `package.json`, its own
database schema and its own tests, next to the main backend and the Vercel service:

| Process | Folder | Port | DB schema |
|---|---|---|---|
| Main backend (Next.js) | `backend/` | 3001 | `public` |
| Vercel integration (Fastify) | `backend/vercel_integration/` | 3002 | `vercel` |
| **Render integration (Fastify)** | **`backend/render_integration/`** | **3003** | **`render`** |

### Rules for the service
- **Standalone.** Node 22 + TypeScript run with `tsx` (no build step), Fastify, Prisma, Vitest.
  - It has its own `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`,
    `.gitignore` and `README.md`.
  - It starts with `npm run dev` inside the folder.
- **No imports from `backend/lib/**` or from `backend/vercel_integration/**`.** Shared plumbing
  (internal auth, secret-box, redact, provider-fetch, provider-error, outbox, callback client,
  deploy queue, fake DB for tests) is **copied** in (decision 2). Each copy carries a header
  comment naming its source.
- **Own data.** Same Postgres instance, but only the `render` schema (`DATABASE_URL=…?schema=render`)
  and its own Prisma migrations in `render_integration/prisma/`.
  - No foreign keys into the backend's tables. `userId`, `componentId` and `deploymentId` are
    plain strings.
  - The backend never reads the `render` schema, and the service never reads `public`.
- **Loopback only.** It listens on `127.0.0.1:3003`. Every route except `/health` requires
  `x-internal-token: <RENDER_SERVICE_TOKEN>`, compared in constant time.
- **Its own secrets.** `RENDER_SERVICE_TOKEN`, `RENDER_CALLBACK_SECRET` and its own
  `ENCRYPTION_KEY` (sealing Render API keys). None are shared with the Vercel service or the
  backend's `ENCRYPTION_KEY`.
- **Never seen by the browser.** The frontend only calls the main backend, which authenticates the
  user and forwards with the user's id.

### Folder layout
```text
backend/render_integration/
├── package.json  tsconfig.json  vitest.config.ts  .env.example  .gitignore  README.md
├── prisma/schema.prisma          # schema "render": RenderCredential, RenderService, RenderDeployment
├── prisma/migrations/            # generated offline (prisma migrate diff --from-empty)
├── scripts/render-spike.ts       # step 0: records real Render API answers
└── src/
    ├── server.ts                 # wiring, resume on boot, graceful shutdown, listen 127.0.0.1:3003
    ├── app.ts                    # Fastify routes + internal-token hook + error mapping
    ├── config.ts                 # env loading/validation (fails fast, lists what is missing)
    ├── db.ts  types.ts           # Prisma client; wire contract shared with the backend (mirrored there)
    ├── auth/internal-auth.ts            # copied
    ├── crypto/secret-box.ts             # copied (own dev fallback key)
    ├── common/redact.ts                 # copied
    ├── http/provider-fetch.ts           # copied; also honours Render's ratelimit-reset header
    ├── http/provider-error.ts           # copied
    ├── render/render-http.ts            # Render REST client + error mapping (step 3)
    ├── render/render.provider.ts        # services, deploys, status, logs, env, cancel, rollback, destroy (step 4)
    ├── render/runtime-map.ts  service-settings.ts  env-vars.ts  service-name.ts
    ├── render/status-map.ts  log-map.ts  error-hints.ts   # pure helpers (step 2)
    ├── render/__fixtures__/             # redacted spike responses
    ├── credentials/credentials.service.ts  credential-input.ts   # step 5
    ├── deployments/deploy-queue.ts      # copied (per-component serialisation)
    ├── deployments/deploy-runner.ts     # poll loop, logs, health probe, terminal handling (step 6)
    ├── deployments/deployments.service.ts  deploy-input.ts  env-vault.ts   # env values in memory only
    ├── callbacks/callback-client.ts  outbox.ts   # copied; adds x-orbitops-provider: render
    └── test-support/fake-db.ts          # copied
    (every module has a sibling *.test.ts)
```

### Who owns what

| Concern | Owner |
|---|---|
| Render API key (sealed), workspace, default region and plan, invalid flag | **render_integration** (`RenderCredential`) |
| The Render service per component (id, name, runtime, region, plan, URL, settings and env hashes, managed env keys) | **render_integration** (`RenderService`) |
| Deploy state (Render deploy id, state, log cursor, callback seq, pending events) | **render_integration** (`RenderDeployment`) |
| Creating/updating services, env sync, deploying, polling, logs, health probe, cancel, resume on restart | **render_integration** |
| Users, sessions, project ownership, `Component` config, `Deployment` rows, log files, `/events` SSE | **main backend** |
| Resolving the commit SHA (GitHub App) and reading `Project.envVars` | **main backend**, sent in the deploy request |

### Internal API (main backend → render_integration)

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness + DB check (no token) |
| `GET /users/:userId/credential` | `{ state, accountName, ownerId, ownerName, owners, region, plan, scopeLocked, lastValidatedAt }`; never the key |
| `PUT /users/:userId/credential` | `{ apiKey }`, validated with `GET /v1/owners`, then sealed and stored |
| `PATCH /users/:userId/credential` | `{ ownerId?, region?, plan? }` (owner locked once a service exists) |
| `DELETE /users/:userId/credential` | forget the key; services on Render are kept |
| `POST /deployments` | `{ deploymentId, userId, component{…, startCmd, healthCheckPath}, repo{fullName, branch}, commitSha, envVars[{key,value}] }`, returns 202; idempotent |
| `GET /deployments/:id`, `GET /deployments?state=active` | state; reconciliation after a backend restart |
| `POST /deployments/:id/cancel` | cancel here and on Render |
| `PUT /components/:componentId/env?userId=` | Phase 9 hook |
| `POST /components/:componentId/rollback?userId=` | Phase 11 hook (`{ renderDeployId }`) |
| `DELETE /components/:componentId?userId=` | delete the Render service; not called by the MVP |

Callbacks go the other way: `POST {MAIN_API_URL}/api/internal/provider-events`, with headers
`x-orbitops-provider: render` and `x-orbitops-signature: sha256=<HMAC(RENDER_CALLBACK_SECRET, body)>`.
They are ordered, persisted before sending, and retried, exactly like Vercel's.

### What changes outside the folder (no Render logic, only the seam)
Step 7 lists the details. In short:
1. **`backend/lib/providers/`:**
   - a base `IntegrationServiceClient` extracted from `VercelServiceClient`;
   - a new `RenderServiceClient` and `render-service.types.ts`;
   - `ProviderDeploymentsService` takes `{ vercel, render }` clients.
2. **`backend/app/api/internal/provider-events/route.ts`:** picks the HMAC secret by
   `x-orbitops-provider` and checks the deployment's provider matches.
3. **`backend/app/api/providers/…`:** credential routes accept `render`.
4. **`backend/prisma/schema.prisma`:** `Component.healthCheckPath` (one nullable column + migration).
5. **`backend/lib/components/`:** `CAN_DEPLOY` adds `render`; Render pre-flight checks (start
   command, runtime).
6. **`backend/lib/runtime.ts`, `backend/.env.example`:** wiring, plus `RENDER_SERVICE_URL`,
   `RENDER_SERVICE_TOKEN`, `RENDER_CALLBACK_SECRET`.
7. **The backend's `tsconfig.json`, `vitest.config.ts` and `eslint.config.mjs`:** exclude
   `render_integration/**`, as was done for `vercel_integration/**`.
8. **Frontend:** the Render card in Settings, the Deploy-to-Render button and health check path on
   the Configure page, **Open api** (step 8). It talks only to the main backend.

### New environment variables

| File | Variable | Purpose |
|---|---|---|
| `render_integration/.env` | `PORT` (3003), `HOST` (127.0.0.1) | where the service listens |
| | `DATABASE_URL` (`…?schema=render`) | its own schema |
| | `ENCRYPTION_KEY` | seals Render API keys; different from every other key |
| | `RENDER_SERVICE_TOKEN` | expected on every call from the backend |
| | `RENDER_CALLBACK_SECRET` | signs events sent back |
| | `MAIN_API_URL` (`http://localhost:3001`) | callback target |
| | `RENDER_API_BASE`, `DEPLOY_CONCURRENCY` (8), `RENDER_POLL_INTERVAL_MS` (3000), `RENDER_DEPLOY_TIMEOUT_MIN` (45) | optional tuning |
| `backend/.env` | `RENDER_SERVICE_URL` (`http://127.0.0.1:3003`), `RENDER_SERVICE_TOKEN`, `RENDER_CALLBACK_SECRET` | the backend's side of the same two secrets |

The Render API key itself never goes in a `.env`. Each user pastes theirs into Settings →
Integrations, the same as the Vercel token.

---

## Design

```text
Browser ─► backend :3001 ──x-internal-token──► render_integration :3003 ──► api.render.com/v1
              ▲   (RENDER_SERVICE_TOKEN)              │
              └── POST /api/internal/provider-events ─┘ x-orbitops-provider: render
                  (HMAC with RENDER_CALLBACK_SECRET)    + x-orbitops-signature
```

- **Render pulls from GitHub itself.** There is no file-upload deploy on Render, so unlike Vercel
  there is no upload fallback, and no GitHub token goes to the service. The user's Render account
  must be connected to GitHub with access to the repo. Public repos may work without that
  connection; the spike confirms.
- **We own triggering.** Services are created with `autoDeployTrigger: "off"` (and the older
  `autoDeploy: "no"` for compatibility). Pushes reach Render only through our push-to-deploy.
- **Creating a service starts a deploy at the branch head.** We adopt that deploy when its
  `commit.id` equals the SHA we resolved; otherwise we cancel it and deploy our SHA. That way a
  deploy always builds the exact commit recorded on our row.
- **Separate secrets per integration service.** A compromised Vercel service cannot forge Render
  events, and vice versa.
  - The backend sends a per-service token.
  - Callbacks name their provider in `x-orbitops-provider`.
  - The backend verifies the HMAC with that provider's secret and checks the deployment's
    `provider` matches.
- **Status mapping** (`deploy.status` → `NormalisedStatus` → `Deployment.status`):

  | Render | Normalised | Deployment |
  |---|---|---|
  | `created`, `queued` | `queued` | `running` |
  | `build_in_progress`, `pre_deploy_in_progress` | `building` | `running` |
  | `update_in_progress` | `deploying` | `running` |
  | `live`, `deactivated` (went live, then superseded) | `live` | `success` |
  | `build_failed`, `update_failed`, `pre_deploy_failed` | `failed` | `failed` |
  | `canceled` | `cancelled` | `cancelled` |

- **Runtime from framework:**

  | Framework | Render runtime |
  |---|---|
  | `nestjs`, `express`, `fastify`, `hono`, `koa`, `node` | `node` |
  | `fastapi`, `flask`, `django`, `python` | `python` |
  | `go`, `gin`, `fiber` | `go` |
  | `rails`, `ruby` | `ruby` |
  | `rust`, `actix`, `axum`, `rocket` | `rust` |
  | `docker` | `docker` (`dockerfilePath = <rootDir>/Dockerfile`, `dockerContext = <rootDir>`) |
  | unknown | pre-flight fail: "set the framework" |

- **Commands:**
  - Render has only `buildCommand` and `startCommand`. Build is `installCmd && buildCmd` (either
    may be absent).
  - Start is **required** (pre-flight).
  - Node version goes in as env var `NODE_VERSION` (major); Python as `PYTHON_VERSION`.
  - Render injects `PORT` (10000). If a deploy fails with "No open ports detected", the error
    message adds the hint "your server must listen on process.env.PORT".

---

## Steps

### 0. API spike — `render_integration/scripts/render-spike.ts` (½ day, needs a Render API key)
Record the real answers, redacted, to `src/render/__fixtures__/`:

| Question | Call(s) |
|---|---|
| Key validation and workspaces | `GET /v1/owners?limit=100` |
| Create shape and the initial deploy | `POST /v1/services` (`type: web_service`, `ownerId`, `repo`, `branch`, `rootDir`, `autoDeployTrigger: "off"`, `serviceDetails { runtime, plan: "free", region, healthCheckPath, envSpecificDetails { buildCommand, startCommand } }`, `envVars`). Does the response hold `deployId`? |
| Error when Render cannot read the repo | create with a private repo whose access is removed; also a public repo without any GitHub connection |
| Deploy an exact commit | `POST /v1/services/:id/deploys` `{ commitId, clearCache: "do_not_clear" }` |
| Status and commit | `GET /v1/services/:id/deploys/:deployId` (status values seen, `commit.id`) |
| Logs | `GET /v1/logs?ownerId=&resource=:id&type=build&type=app&startTime=&direction=forward&limit=100`: shape, `labels`, `hasMore`/`nextStartTime` |
| Cancel | `POST /v1/services/:id/deploys/:deployId/cancel` |
| Env vars | `PUT /v1/services/:id/env-vars/:key` `{ value }` and `DELETE …/env-vars/:key` |
| Rate limits | `Ratelimit-Remaining` / `Ratelimit-Reset` headers on a 429 |

It creates one service named `orbitops-spike-*` (plan `free`) and deletes it at the end.

### 1. Scaffold `backend/render_integration/` (copy of the Vercel service's skeleton)
- Copy from `backend/vercel_integration`, renaming `vercel` → `render`:
  - `package.json` (name `orbitops-render-integration`), `tsconfig.json`, `vitest.config.ts`,
    `.gitignore`, `.env.example`;
  - `src/config.ts` (adds `DEFAULT_REGION`, `PORT` 3003);
  - `src/auth/internal-auth.ts`, `src/crypto/secret-box.ts`, `src/common/redact.ts`;
  - `src/http/provider-fetch.ts`: also read `ratelimit-reset` (seconds), which is Render's header;
  - `src/http/provider-error.ts`;
  - `src/callbacks/{callback-client,outbox}.ts`: the callback client adds header
    `x-orbitops-provider: render`;
  - `src/deployments/deploy-queue.ts`, `src/test-support/fake-db.ts`, `src/app.ts`,
    `src/server.ts`.
- Drop what Render does not need: `token-vault.ts`, `github/source-archive.ts`, `common/fs-utils.ts`.
- `prisma/schema.prisma` (schema `render`):
  - `RenderCredential { userId @unique, apiKeyEnc, accountName, ownerId, ownerName, owners Json,
    region @default("oregon"), plan @default("free"), invalidAt?, lastValidatedAt }`;
  - `RenderService { componentId @unique, userId, renderServiceId, name, ownerId, region, plan,
    runtime, url?, dashboardUrl?, settingsHash, envHash, managedEnvKeys Json }`;
  - `RenderDeployment { deploymentId @unique, userId, componentId, input Json, state,
    renderDeployId?, url?, dashboardUrl?, errorMessage?, lastLogAt String?, callbackSeq,
    pendingEvents Json, createdAt, finishedAt? }`.
- Migration generated offline: `prisma migrate diff --from-empty …`, as in Phase 6.

### 2. Pure helpers (`src/render/`), each with a unit test
- `runtime-map.ts`: framework → runtime (table above); `null` when unknown.
- `service-settings.ts`:
  - `toServiceSettings(component, defaults)` → `{ runtime, rootDir ("" for "."), buildCommand,
    startCommand, healthCheckPath, region, plan, dockerfilePath? }`;
  - `settingsHash()`, which covers only the PATCHable fields: commands, rootDir, branch,
    healthCheckPath.
- `env-vars.ts`:
  - `toEnvVars(projectEnv, component, runtime)` adds `NODE_VERSION` / `PYTHON_VERSION` from
    `nodeVersion`;
  - `envHash()`;
  - `diffManaged(previousKeys, nextKeys)` → keys to delete (only ones we set before; vars added by
    hand on Render's dashboard survive).
- `service-name.ts`: `<repo>-<component>`, lowercase, dashes only, ≤ 60 chars; a random suffix on a
  conflict.
- `status-map.ts`: the table above.
- `log-map.ts`: Render log entries → `LogLine` (id, timestamp ms, `stream` from the
  `level`/`type` labels, text). Drops `request`-type entries.
- `error-hints.ts`: "No open ports detected" → PORT hint; "Could not access repository" → GitHub
  connection hint.

### 3. HTTP client — `src/render/render-http.ts`
- `renderRequest(ctx, method, path, opts)`:
  - base `RENDER_API_BASE ?? https://api.render.com/v1`, `Authorization: Bearer <key>`;
  - built on the copied `providerFetch`;
  - `redirect: "error"`, as the prior art did.
- `renderError(response, action)` → `ProviderError`:

  | Render response | Mapped to |
  |---|---|
  | 401 | 412 `render_key_invalid` + `invalidToken` |
  | 403 | 403 `render_forbidden` |
  | 402 | 429 `render_billing` ("this plan needs billing details on Render") |
  | 404 on `/services/:id` | handled by callers (recreate) |
  | 400/404 mentioning the repo/Git | 400 `render_repo_access` with the GitHub-connection hint |
  | 409 | 409 `render_conflict` |
  | 429 | `render_rate_limited` (retryable) |
  | 5xx | 502 `render_unavailable` (retryable) |

  Render's raw error text is passed through only after redaction. The prior art warns it can echo
  configuration.

### 4. `RenderProvider` — `src/render/render.provider.ts`
- `validateCredentials(key)`: `GET /owners` (paged), returning `{ accountName, owners[{id, name,
  type}] }`.
- `ensureService(ctx, known, component, repo, defaults, env, log)`:
  1. If `known`: `GET /services/:id`.
     - 404 → log and recreate.
     - Settings hash changed → `PATCH /services/:id` (branch, rootDir, `autoDeployTrigger: "off"`,
       `serviceDetails { healthCheckPath, envSpecificDetails { buildCommand, startCommand } }`).
     - Runtime/region/plan are never PATCHed. If they differ, log "fixed after creation; change it
       on Render".
  2. Else create:
     - `POST /services` with the settings, `envVars`, `autoDeployTrigger: "off"`, and
       `repo: https://github.com/<owner>/<repo>`.
     - 409/name taken → suffix and retry.
     - Repo-access error → `render_repo_access`; no fallback.
     - Returns the `initialDeployId` from the response.
  3. Env sync when `envHash` changed: `PUT /services/:id/env-vars/:key` for each var, and
     `DELETE` for managed keys no longer present. Values are added to the log redaction list.
- `deploy(ctx, service, commitSha, initialDeployId?)`:
  - If there is an initial deploy and its `commit.id === commitSha`, adopt it.
  - Else cancel it if present, then `POST /services/:id/deploys { commitId, clearCache:
    "do_not_clear" }`.
  - Returns `{ providerDeploymentId, dashboardUrl }`:
    `https://dashboard.render.com/web/<serviceId>/deploys/<deployId>`.
- `getStatus(ctx, serviceId, deployId)` → `{ status, url: service.serviceDetails.url,
  errorMessage }`:
  - the error message is built from the status plus a hint from the last log lines;
  - the URL goes through `safeServiceUrl` (https, `*.onrender.com`, no credentials), taken from the
    prior art.
- `getLogs(ctx, ownerId, serviceId, since)`: `GET /logs` with `resource=serviceId`,
  `type=build&type=app`, `startTime=since`, `direction=forward`, following `hasMore`/
  `nextStartTime` up to 5 pages per poll.
- `cancel`, `rollback(serviceId, deployId)` (Phase 11 hook), `setEnv` (Phase 9 hook), `destroy`
  (`DELETE /services/:id`; implemented, not called).
- `probeHealth(url, path)`:
  - after live: `GET url+path` up to 6 times over ~90 s (free instances cold-start);
  - **logs** the result and never fails the deploy.

### 5. Credentials — `src/credentials/`
Same as the Vercel version, plus region and plan defaults:
- `save(userId, apiKey)`:
  - validate, seal, upsert;
  - the default owner is the first `user`-type owner (else the first);
  - keeps the owner if the same account re-saves.
- `setPreferences(userId, { ownerId?, region?, plan? })`:
  - `ownerId` must be in the key's owners list;
  - `ownerId` is locked (409) once a `RenderService` exists;
  - region in `{oregon, ohio, virginia, frankfurt, singapore}`, plan in `{free, starter,
    standard}`.
- `get` → `{ provider: "render", state, accountName, ownerId, ownerName, owners, region, plan,
  scopeLocked, lastValidatedAt }`.
- `getKey(userId)`, `markInvalid(userId)`.

### 6. Runner + service — `src/deployments/`
- `deploy-runner.ts`, the same shape as Vercel's:
  1. `setState(deploying)`, then the log section "Preparing Render service".
  2. `ensureService`. Persist `RenderService` **before** deploying, then emit `resource`.
  3. `deploy`. Persist `renderDeployId` and emit `deployment`, with `sourceMode: "git"`, the
     service URL and the dashboard URL.
  4. Poll every 3 s, backing off to 10 s, until terminal or 45 min:
     - status changes → `status` events;
     - logs since `lastLogAt` → `logs` events, deduped by id;
     - on `live`: health probe, then a `terminal` event with `productionUrl = service URL`.
- Abort with reason `cancel` cancels the deploy on Render. Reason `shutdown` leaves it running and
  resumes on start.
- `deployments.service.ts`:
  - `start(request)` is idempotent on `deploymentId`. The env vars are held **in memory** for the
    run (a `vault`, like the GitHub token on Vercel) and never stored.
  - `get`, `listActive`, `cancel`, `resumeAll`:
    - a row with a `renderDeployId` resumes polling;
    - a row without one is failed with "deploy again", because its env vars were only in memory.
- Internal API (`src/app.ts`) mirrors Vercel's. `PATCH /users/:userId/credential` takes
  `{ ownerId?, region?, plan? }`.

### 7. Main backend seam (no Render logic here)
- **Clients:**
  - `lib/providers/integration-service.client.ts`: extract the shared `call()` from
    `VercelServiceClient` into a base class `IntegrationServiceClient(name, loadConfig)`.
  - `VercelServiceClient` keeps its methods and env (`VERCEL_SERVICE_URL`,
    `INTERNAL_SERVICE_TOKEN`).
  - New `RenderServiceClient`: `RENDER_SERVICE_URL` (default `http://127.0.0.1:3003`),
    `RENDER_SERVICE_TOKEN`.
  - `lib/providers/render-service.types.ts` mirrors the service's request and view types.
- **`ProviderDeploymentsService`** (`lib/providers/provider-deployments.service.ts`):
  - takes `clients: { vercel, render }` instead of one client;
  - `deployComponent` picks the client by `component.provider` and builds the request per provider:
    - Render gets `component` (incl. `startCmd`, `healthCheckPath`), `repo`, `commitSha`, and
      `envVars` from `Project.envVars`;
    - Render gets no GitHub token;
  - `cancel`, `reconcile` and `handlePush` loop over providers. `handlePush` includes `render`
    components that already have a `providerResourceId`; the watch path stays `rootDir/**`.
  - The "arrives in Phase 7" branch is removed.
- **Callback route** (`app/api/internal/provider-events/route.ts`):
  - choose the secret by `x-orbitops-provider`: `vercel` → `INTERNAL_CALLBACK_SECRET`, `render` →
    `RENDER_CALLBACK_SECRET`; missing header = vercel, for backward compatibility;
  - after verifying, reject a batch whose deployment's `provider` differs (403);
  - `applyBatch` is unchanged.
- **Credentials:**
  - `lib/providers/credential-input.ts`: `parseProviderParam` accepts `render`;
    `parseRenderPrefsBody`.
  - `app/api/providers/[provider]/credential/route.ts` dispatches by provider.
  - `app/api/providers/credentials/route.ts` returns the real Render state.
- **Component:**
  - new optional `healthCheckPath String? @db.VarChar(200)` on `Component` (migration
    `…_render_provider`);
  - validator in `lib/components/component-input.ts`: starts with `/`, ≤ 200 chars, null for
    database/frontend.
- **Pre-flight** (`lib/components/preflight.ts`, `provider-rules.ts`):
  - `CAN_DEPLOY` adds `render`;
  - `credentialState` for render goes through the client (in `lib/runtime.ts`);
  - new per-component checks for Render backends:
    - `start-cmd:<id>`: start command present;
    - `runtime:<id>`: a framework Render can run;
    - `env:<id>` (existing) already covers `.env.example` keys;
  - a message notes that Render must be connected to GitHub (cannot be pre-checked).
- **Wiring and env:** `lib/runtime.ts` wires `RenderServiceClient`. `backend/.env.example` adds
  `RENDER_SERVICE_URL`, `RENDER_SERVICE_TOKEN` and `RENDER_CALLBACK_SECRET`.

### 8. Frontend
- `components/ProviderCredentialCard.tsx` is generalised with a per-provider config:
  - Vercel: "Access token", vercel.com/account/tokens, scope "Team".
  - Render: "API key", https://dashboard.render.com/u/settings#api-keys, scope "Workspace", plus
    **Region** and **Plan** selects. The plan note says "Free instances sleep after 15 min idle".
- `settings/page.tsx`: the Render row becomes the real card. It notes "Render must be connected to
  GitHub: dashboard.render.com → Account Settings → Git".
- `lib/deploy/types.ts`:
  - `CAN_DEPLOY` adds `render`;
  - `ComponentFields.healthCheckPath`;
  - `ProviderCredential` gains `ownerId`, `ownerName`, `owners`, `region`, `plan`.
- `lib/deploy/client.ts`: `saveProviderToken`, `setProviderTeam` → `setProviderPreferences` take
  `"vercel" | "render"`.
- `configure/page.tsx`:
  - the Backend card gets **Health check path** (placeholder `/health`) and **Deploy to Render**;
  - a "required" hint on Start command;
  - existing `deployable` logic unchanged.
- `deploy/[projectId]/page.tsx`: `liveSites` already includes backends; the button label becomes
  **Open api** for a backend.
- `deploy/builds/[deploymentId]/page.tsx`: no change. It is provider-generic; the chip reads
  "Render · from GitHub" and the link "View on Render".

### 9. Docs
- README:
  - architecture (third service, :3003);
  - Terminal 4 run block;
  - a **"Render setup"** section: API key, connect Render to GitHub, region/plan, PORT,
    free-tier sleep, shared secrets;
  - env tables.
- `backend/render_integration/README.md`, modelled on Vercel's.
- `frontend/docs/API_CONTRACT.md`: Render credential routes, prefs body, error codes.
- `PLAN.md`: Phase 7 checklist and status.

---

## Out of scope
- Neon and `DATABASE_URL` injection, and "Deploy all" ordering with `NEXT_PUBLIC_API_URL` (Phase 8).
- Encrypted per-component env vars (Phase 9). Phase 7 reads the existing `Project.envVars`.
- Rollback UI (Phase 11; `rollback()` is implemented).
- Background workers, cron jobs and private services: only `web_service`.
- Changing region/plan after creation (done on Render).
- Deleting services automatically.

## Verification
1. **Build hygiene:**
   - `render_integration`: `npx tsc --noEmit && npm test`;
   - `backend` and `frontend`: `npm run typecheck && npm run lint && npm test`;
   - `prisma validate` on both changed schemas;
   - Vercel's service tests still pass, untouched.
2. **Unit tests** (vitest, `fetch` stubbed, spike fixtures replayed):
   - pure helpers: runtime map, settings + hash, env diff + hash, names, status, logs, hints;
   - `render-http`: error mapping, `ratelimit-reset` honoured, no key in errors;
   - provider:
     - create once, then PATCH only on change;
     - recreate on 404;
     - adopt the initial deploy when the SHA matches, else cancel and deploy the SHA;
     - env upsert and delete of removed managed keys only;
     - repo-access error;
   - credentials: sealed, owner lock, prefs validation;
   - outbox/callback: the provider header is set;
   - runner:
     - resume;
     - cancel vs shutdown;
     - health probe failure does not fail the deploy;
     - env values never in relayed logs;
   - API: `inject()`, 401 without the token.
3. **Backend tests:**
   - `provider-deployments.service.test.ts` extended for render (request shape incl. `envVars`, no
     GitHub token);
   - callback route: wrong-provider secret → 401, provider mismatch → 403;
   - credential routes accept render;
   - pre-flight: start-cmd/runtime checks; render deployable once connected.
4. **Manual**, with the `Vercel_Integration_test` repo (`backend/` = Express on
   `process.env.PORT`):
   - Settings: bad key → error; good key → workspace listed; set region/plan; Connected.
   - Configure: the Backend card's pre-flight passes, and **Deploy to Render** is enabled.
   - Deploy: chips "Render · from GitHub"; log shows the Render build; status queued → building →
     deploying → live; **Open api** → `https://<name>.onrender.com/health` returns `{status:"ok"}`.
   - Env: add `GREETING=hi` on the project, then redeploy. `GET /` shows it (make the test
     backend echo it), and the value never appears in our log.
   - Push only `backend/` → only the backend redeploys. Push only `frontend/` → only Vercel.
     Render shows no auto-deploys of its own.
   - Break the start command → failed with Render's message (+ hint).
   - Cancel mid-build → cancelled both here and on Render.
   - Restart `render_integration` mid-build → it resumes.
   - Remove Render's GitHub access → clear `render_repo_access` error.
   - Stop the service → Settings shows "Unavailable", pre-flight fails cleanly.
   - A second user is blocked (404). Vercel deploys still work.
