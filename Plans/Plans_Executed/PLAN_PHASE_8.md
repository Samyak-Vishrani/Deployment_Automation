# Phase 8 — Neon Database + "Deploy all": implementation plan

> Companion to `PLAN_PHASE_6.md` and `PLAN_PHASE_7.md`. Work through the steps below in order.
>
> **Status: code implemented and tested (2026-11-03); not yet verified live against a real Neon
> account.** Every step except step 0 is done. The live end-to-end checks in Verification §3 need
> a Neon API key.
>
> | Step | State |
> |---|---|
> | 0. API spike | 🟡 `scripts/neon-spike.ts` written; **not run**, since no Neon API key is on this machine (`NEON_API_KEY=… npm run spike`). The texts it confirms are matched loosely until then (`PROJECT_LIMIT`, `ORG_REQUIRED` in `src/neon/neon-http.ts`) |
> | 1. Extract `integration_common` | ✅ 10 modules, 37 tests. Both services switched over. Their superseded copies are renamed `xxx_*` (your rule: mark, don't delete) and excluded from `tsc` and Vitest. Both services start and report healthy, and the real sealed Vercel and Render credentials still open |
> | 2. Scaffold `neondb_integration` | ✅ :3004, schema `neon`, migration `202611030004_init` applied locally. A dev `.env` was created with fresh secrets, and `NEON_SERVICE_URL` / `NEON_SERVICE_TOKEN` were appended to `backend/.env` |
> | 3–6. Helpers, HTTP client, provider, credentials, databases API | ✅ 66 tests. Live: `/health` ok, 401 without the token, and a fake key sent to the real Neon API maps to `neon_key_invalid` |
> | 7. Vercel `publicEnvVars` | ✅ migration `202611030005_public_env` applied locally; 88 Vercel tests |
> | 8. Backend seam | ✅ client, credentials, pre-flight, `provisionDatabase`, env injection, reconcile. Checked live: the backend's client gets every error code through the running service |
> | 9. Releases | ✅ `Release` model + migration `202611030006_releases` applied locally; orchestrator, routes, `release` event, resume on boot |
> | 10. Frontend | ✅ Neon card in Settings, Provision + Deploy all on Configure, release strip + database row on the project page, Neon chip on the build page |
> | 11. Docs | ✅ root README (Neon setup, Deploy all, Terminal 5, env), all three service READMEs plus `integration_common`'s, `API_CONTRACT.md`, `PLAN.md` |
>
> Verification:
> - **§1 build hygiene ✅**
>   - Tests: `integration_common` 37, `vercel_integration` 88, `render_integration` 96,
>     `neondb_integration` 66, backend 335, frontend 6.
>   - Typecheck and lint are clean in all of them.
>   - `next build` passes for the backend and the frontend.
>   - After step 1 alone the count was 212 against 209 before.
> - **§2 unit tests ✅**
> - **§3 manual ⬜**, all of it: it needs a Neon API key and the five processes running.
> - **Live re-check after the step 1 refactor:** only startup and opening the stored credentials
>   were checked. A real Vercel and Render redeploy has not been run since.
>
> Where the code departs from the text below, and why:
> - **Provisioning runs in the background in the backend.** `deployComponent` returns the
>   `running` row at once, like the other providers. This keeps the HTTP request short and the
>   build page streaming. A backend deploy that needs the database waits for it.
> - **SvelteKit gets `PUBLIC_API_URL`, not `VITE_API_URL`.** That is SvelteKit's own convention for
>   browser-visible variables (`$env/static/public`).
> - **The Vercel API URL has three cases:**
>   - the backend is not deployed yet, or there are several backends: `publicEnvVars` is omitted,
>     so the URL set before is kept;
>   - there is no backend at all: `[]` is sent, so a URL set before is removed;
>   - exactly one backend with a URL: that URL is sent.
> - **`fastify-plumbing` was not extracted.** Importing Fastify types from a linked package could
>   pull in a second Fastify. The internal-token hook is small and stays in each service's
>   `app.ts`, using the shared `isValidInternalToken`.
> - **More Neon error codes than step 3 listed:** `neon_org_required`, `neon_database_gone`,
>   `neon_database_not_ready`, `neon_unexpected_response`.
> - **A project whose setup failed is replaced** on the next ensure: it holds no data. A project
>   deleted on Neon is recreated empty, with a warning in the log.
> - **Cancelling a release does not cancel a Neon provisioning** (it takes seconds). The release is
>   marked cancelled first, so nothing after it starts.
> - **`GET /options` was added** to the Neon service: regions and Postgres versions. The frontend
>   currently uses its own copy in `NEON_REGIONS`.

## Context

`PLAN.md` Phase 8 says: "provision Postgres and pass it to the backend automatically". Phases 6 and 7
are done and live. A Next.js frontend deploys to Vercel and an Express backend to Render, each from
its own integration service. The database component already exists:
- it can be configured (the "Add database (Neon)" toggle);
- analysis proposes it when it sees Postgres (`lib/analysis/database-hints.ts`);
- pre-flight already treats `DATABASE_URL` as provided by it (`PROVIDED_BY_DATABASE` in
  `lib/components/preflight.ts`).

Nothing provisions it yet:
- `CAN_DEPLOY` excludes `neon`;
- `deployComponent` throws "arrives in Phase 8";
- the Settings row says "Arrives in Phase 8".

There is also no way to deploy a whole project in the right order. A user has to deploy the backend
and the frontend separately, and copy URLs between them by hand.

**Done when:** on `/deploy/<id>/configure`, one **Deploy all** click on a repo with `frontend/`
(Next.js), `backend/` (Express + `pg`) and a Database card does the following:
1. creates a Neon project;
2. deploys the backend to Render with `DATABASE_URL` set, with no copy-paste, and the backend can
   query Postgres;
3. waits until the backend is live;
4. deploys the frontend to Vercel with `NEXT_PUBLIC_API_URL` = the backend's `*.onrender.com` URL;
5. shows the whole run as one **Release** (Database → Backend → Frontend) on the project page.

A later push touching only `backend/` redeploys the backend, still with `DATABASE_URL`.

### Decisions made with the user (2026-11-03)
1. **New service `backend/neondb_integration`** on **:3004**, Postgres schema `neon`, with its own
   secrets. It follows the Vercel/Render pattern.
2. **Full Deploy all.** It includes:
   - a `Release` record grouping one click's deployments;
   - ordered stages;
   - `DATABASE_URL` injected into Render;
   - the API URL injected into Vercel.

   Push deploys get the same env injection.
3. **Extract `backend/integration_common` now.**
   - The plumbing copied between `vercel_integration` and `render_integration` moves into one local
     package that all three services import.
   - This happens first, as a pure refactor, before any Neon code.

### Further design choices in this plan (recommended defaults; change before executing if needed)
- **Provisioning is synchronous.**
  - Creating a Neon project takes seconds, so `neondb_integration` has no runner, outbox or callbacks.
  - The backend calls `POST /databases` (idempotent per component). The service waits for Neon's
    operations to finish (≤ 60 s) and returns.
  - The backend writes the Deployment row and its log lines itself.
- **Connection strings are never stored.**
  - Neither the backend nor `neondb_integration` keeps them at rest. The service fetches them from
    Neon (`GET /projects/:id/connection_uri`) whenever the backend asks, and the backend holds them
    in memory only, for the one deploy request.
  - A password reset on Neon is picked up automatically.
  - Removing the Neon API key makes the next backend deploy fail with "Reconnect Neon".
- **Two system env vars go to the backend:**
  - `DATABASE_URL`: pooled, for the app;
  - `DATABASE_URL_UNPOOLED`: direct, for migrations; the README shows Prisma's
    `directUrl = env("DATABASE_URL_UNPOOLED")`.

  They override any same-named project env var. The log says so, naming only the key.
- **Migrations are not run for the user.** Pre-flight's Database check advises adding
  `npx prisma migrate deploy` (or the ORM's equivalent) to the backend build command.
- **Default Neon region `aws-us-west-2` (Oregon)**, next to Render's default region. Postgres 17.
  Both can be changed in Settings and are fixed once the project exists.
- **API URL key per frontend framework:**

  | Framework | Key |
  |---|---|
  | `next` | `NEXT_PUBLIC_API_URL` |
  | `vite`, `react` (vite), `vue`, `svelte`, `sveltekit` | `VITE_API_URL` |
  | `nuxt` | `NUXT_PUBLIC_API_URL` |
  | `astro` | `PUBLIC_API_URL` |
  | `react` (react-scripts) | `REACT_APP_API_URL` |
  | anything else | `API_URL` |

  It is injected only when the project has **exactly one** backend with a URL. Otherwise it is
  skipped, with a log line.

---

## Constraint: all Neon code in `backend/neondb_integration/`, as its own microservice

**Every line of Neon-specific code goes in a new folder, `backend/neondb_integration/`, which runs
as a separate microservice, exactly as `backend/vercel_integration/` and
`backend/render_integration/` do.** It is its own process with its own `package.json`, its own
database schema and its own tests. It sits next to the main backend and the other two services:

| Process | Folder | Port | DB schema |
|---|---|---|---|
| Main backend (Next.js) | `backend/` | 3001 | `public` |
| Vercel integration (Fastify) | `backend/vercel_integration/` | 3002 | `vercel` |
| Render integration (Fastify) | `backend/render_integration/` | 3003 | `render` |
| **Neon DB integration (Fastify)** | **`backend/neondb_integration/`** | **3004** | **`neon`** |
| **Shared library (no process)** | **`backend/integration_common/`** | — | — |

### Rules for the service
The rules are the same as Phase 7, except that the shared plumbing is now imported from
`integration_common` instead of copied.
- **Standalone.** Node 22 + TypeScript run with `tsx` (no build step), Fastify 5, Prisma 5, Vitest.
  - Its own files: `package.json` (name `orbitops-neondb-integration`), `tsconfig.json`,
    `vitest.config.ts`, `.env.example`, `.gitignore`, `README.md`.
  - It starts with `npm run dev` inside the folder (`tsx watch src/server.ts`), in its own
    terminal, like the other two services.
  - It can be deployed on its own, because nothing outside the folder is needed at runtime except
    the linked `integration_common` package.
- **Imports.** Only its own `src/` and `@orbitops/integration-common`. Never `backend/lib/**`,
  `backend/app/**`, `backend/vercel_integration/**` or `backend/render_integration/**`.
- **Own data.**
  - Same Postgres instance, but only the `neon` schema (`DATABASE_URL=…?schema=neon`), with its
    own Prisma schema and migrations in `neondb_integration/prisma/`.
  - No foreign keys into the backend's tables: `userId` and `componentId` are plain strings.
  - The backend never reads the `neon` schema, and the service never reads `public`.
- **Loopback only.** It listens on `127.0.0.1:3004`. Every route except `/health` requires
  `x-internal-token: <NEON_SERVICE_TOKEN>`, compared in constant time
  (`integration_common/internal-auth`).
- **Its own secrets.**
  - `NEON_SERVICE_TOKEN`, and its own `ENCRYPTION_KEY` that seals Neon API keys.
  - Neither is shared with the Vercel or Render services or with the backend's `ENCRYPTION_KEY`.
  - It needs no callback secret, because it sends no callbacks (provisioning is synchronous).
- **Never seen by the browser.** The frontend only calls the main backend, which authenticates the
  user and forwards with the user's id.
- **Never stores a connection string.** Neon API keys are sealed at rest. Connection URIs are
  fetched from Neon on demand and returned only by `GET /databases/:componentId/connection`.

### Folder layout
```text
backend/neondb_integration/
├── package.json  tsconfig.json  vitest.config.ts  .env.example  .gitignore  README.md
├── prisma/schema.prisma          # schema "neon": NeonCredential, NeonDatabase
├── prisma/migrations/            # generated offline (prisma migrate diff --from-empty)
├── scripts/neon-spike.ts         # step 0: records real Neon API answers
└── src/
    ├── server.ts                 # wiring, graceful shutdown, listen 127.0.0.1:3004
    ├── app.ts                    # Fastify routes + internal-token hook + error mapping (from integration_common)
    ├── config.ts                 # env loading/validation (fails fast, lists what is missing)
    ├── db.ts  types.ts           # Prisma client; wire contract shared with the backend (mirrored there)
    ├── neon/neon-http.ts         # Neon REST client + error mapping (step 3)
    ├── neon/neon.provider.ts     # validate key, create/find project, wait for operations, connection URIs, destroy (step 4)
    ├── neon/project-name.ts  regions.ts  connection.ts  operations.ts   # pure helpers (step 3)
    ├── neon/__fixtures__/        # redacted spike responses
    ├── credentials/credentials.service.ts  credential-input.ts   # step 5
    ├── databases/databases.service.ts  database-input.ts         # ensure / get / connection / destroy (step 6)
    └── test-support/fake-db.ts   # in-memory Prisma stand-in for tests
    (every module has a sibling *.test.ts)
```
There is no `deployments/`, `callbacks/` or outbox: unlike Vercel and Render, nothing here polls in
the background or reports back.

### Who owns what

| Concern | Owner |
|---|---|
| Neon API key (sealed), organization, default region and Postgres version, invalid flag | **neondb_integration** (`NeonCredential`) |
| The Neon project per database component (project id, branch, database, role, region, host, state) | **neondb_integration** (`NeonDatabase`) |
| Creating projects, waiting for operations, fetching connection URIs, deleting projects | **neondb_integration** |
| Users, sessions, project ownership, `Component` config, `Deployment` and `Release` rows, log files, `/events` SSE | **main backend** |
| Putting `DATABASE_URL` / `DATABASE_URL_UNPOOLED` into the Render deploy request (in memory only) | **main backend** |

### Internal API (main backend → neondb_integration)
The full table is in step 6. In short:
- `GET /health`;
- `GET/PUT/PATCH/DELETE /users/:userId/credential`;
- `POST /databases` (ensure, idempotent);
- `GET /databases/:componentId`;
- `GET /databases/:componentId/connection`, the only secret-bearing route;
- `DELETE /databases/:componentId`.

### What changes outside the folder (no Neon logic, only the seam)
Steps 1 and 7–10 list the details. In short:
1. **`backend/integration_common/`:** the extracted shared plumbing (step 1).
2. **`backend/lib/providers/`:** a new `NeonServiceClient` + `neon-service.types.ts`. Also
   `ProviderDeploymentsService` gets `provisionDatabase`, `systemEnvFor` and the Neon reconcile.
3. **`backend/app/api/providers/…`:** credential routes accept `neon`.
4. **`backend/lib/components/`:** `CAN_DEPLOY` adds `neon`, plus the Database pre-flight checks.
5. **`backend/lib/releases/`, `backend/app/api/…/releases`, `backend/prisma/schema.prisma`:** the
   Release model and Deploy all (step 9).
6. **`backend/vercel_integration/`:** `publicEnvVars` for the API URL (step 7).
7. **`backend/lib/runtime.ts`, `backend/.env.example`:** wiring, plus `NEON_SERVICE_URL` and
   `NEON_SERVICE_TOKEN`.
8. **The backend's `tsconfig.json`, `vitest.config.ts` and `eslint.config.mjs`:** exclude
   `neondb_integration/**` and `integration_common/**`, as was done for `vercel_integration/**` and
   `render_integration/**`.
9. **Frontend:** the Neon card in Settings, Provision and Deploy all on Configure, and the release
   strip on the project page (step 10). It talks only to the main backend.

### New environment variables

| File | Variable | Purpose |
|---|---|---|
| `neondb_integration/.env` | `PORT` (3004), `HOST` (127.0.0.1) | where the service listens |
| | `DATABASE_URL` (`…?schema=neon`) | its own schema |
| | `ENCRYPTION_KEY` | seals Neon API keys; different from every other key |
| | `NEON_SERVICE_TOKEN` | expected on every call from the backend |
| | `NEON_API_BASE`, `NEON_PROVISION_TIMEOUT_MS` (60000), `DEFAULT_REGION` (`aws-us-west-2`), `DEFAULT_PG_VERSION` (17) | optional tuning |
| `backend/.env` | `NEON_SERVICE_URL` (`http://127.0.0.1:3004`), `NEON_SERVICE_TOKEN` | the backend's side of the shared token |

The Neon API key itself never goes in a `.env`. Each user pastes theirs into Settings →
Integrations, the same as the Vercel token and the Render API key.

```text
Browser ─► backend :3001 ──x-internal-token──► neondb_integration :3004 ──► console.neon.tech/api/v2
                           (NEON_SERVICE_TOKEN)        (sync: ensure / connection)
           backend :3001 ──► render_integration :3003   (deploy request carries DATABASE_URL, in memory)
           backend :3001 ──► vercel_integration :3002   (deploy request carries the public API URL)
```

---

## Steps

### 0. API spike — `neondb_integration/scripts/neon-spike.ts` (½ day, needs a Neon API key)
Record the real answers, redacted, to `neondb_integration/src/neon/__fixtures__/`:

| Question | Call(s) |
|---|---|
| Key validation, account name | `GET /api/v2/users/me` (does an **organization** API key get 401/403 here?) |
| Organizations | `GET /api/v2/users/me/organizations`. Is `org_id` required on create for this account? |
| Create shape | `POST /api/v2/projects` `{ project: { name, region_id: "aws-us-west-2", pg_version: 17, org_id? } }`: are `connection_uris`, `roles`, `databases`, `branch`, `endpoints` and `operations` all in the response? |
| Readiness | `GET /api/v2/projects/:id/operations`: status values (`running`, `finished`, `failed`, …) |
| Connection strings | `GET /api/v2/projects/:id/connection_uri?database_name=&role_name=&pooled=true` and `pooled=false` |
| Gone project | `GET /api/v2/projects/:id` after delete → 404 shape |
| Locked | the status code while operations run (expected 423) |
| Plan limit | the error text when the free plan's project limit is hit (create until it fails, if cheap; else read the docs) |
| Rate limits | headers on a 429 |

It creates one project named `orbitops-spike-*` and deletes it at the end. Its output decides two
things: whether an org picker is required, and how `isProjectLimitError` / `isLockedError` match.

### 1. Extract `backend/integration_common/` (pure refactor, no behaviour change)
- **Package:**
  - `backend/integration_common/package.json`: name `@orbitops/integration-common`,
    `"type": "module"`, `private`, TS source only.
  - `exports` map each entry to its `.ts` file:
    `"./internal-auth": "./src/internal-auth.ts"`, and so on.
  - `tsconfig.json` and `vitest.config.ts` copied from `render_integration`. `README.md`.
- **Modules.** Each is the merged version of the two copies, which `diff` shows differ only in
  comments and names:

  | Module | From | Parameterised by |
  |---|---|---|
  | `internal-auth.ts` | `src/auth/internal-auth.ts` | — |
  | `secret-box.ts` | `src/crypto/secret-box.ts` | `createSecretBox({ key, devFallbackSeed })` → `{ seal, open }`; each service passes its own seed (`orbitops-render-integration-local-dev-key`, …) so existing sealed values still open |
  | `redact.ts` | `src/common/redact.ts` | — |
  | `provider-fetch.ts` | Render's copy (the superset: `retry-after`, `x-ratelimit-reset`, `ratelimit-reset`) | — |
  | `provider-error.ts` | `src/http/provider-error.ts` | provider-neutral doc text |
  | `callback-client.ts` | Render's copy | `provider` (header `x-orbitops-provider`). **Vercel now sends `vercel`**, which the backend already accepts; a missing header still means vercel |
  | `outbox.ts` | `src/callbacks/outbox.ts` | a `PendingEventStore` interface (`loadPending()`, `append(deploymentId, batch)`, `ack(deploymentId, seq)`) instead of `db.vercelDeployment` / `db.renderDeployment`; each service adds a 30-line Prisma adapter |
  | `deploy-queue.ts` | `src/deployments/deploy-queue.ts` | provider-neutral comments |
  | `contract.ts` | the shared parts of each `src/types.ts` | `EventBatch`, `ProviderEvent`, `ProviderStatus`, `LogLine`, `EnvVar` |
  | `config-helpers.ts` | the identical parts of `config.ts` | `requireEnv`, `MissingEnvError`, `intEnv` |
  | `fastify-plumbing.ts` | the identical parts of `app.ts` | internal-token hook and `ProviderError` → `{ error, message }` mapping, if the two copies match; otherwise left per service |
- **Kept per service:**
  - `fake-db.ts` (it differs by schema);
  - `db.ts`;
  - the provider folders;
  - the services;
  - `config.ts`, slimmed to use the helpers.
- **Wiring:**
  - each service's `package.json` adds `"@orbitops/integration-common": "file:../integration_common"`;
    `npm install` links it;
  - the moved tests (`secret-box.test.ts`, `outbox.test.ts`, `deploy-queue.test.ts`, the
    provider-fetch tests) move into `integration_common/src/` and run there with `npm test`.
- **Check before going further** (step 1 is done only when all of these hold):
  - `tsx`, `tsc` and `vitest` all resolve the linked `.ts` source on Windows.
  - Vitest follows the symlink to the real path outside `node_modules`, so it transforms the file.
  - If any of the three refuses, fall back to a `tsconfig` `paths` alias plus a Vitest `resolve.alias`
    to `../integration_common/src`. Note the choice in `integration_common/README.md`.
  - Both services' test suites pass, with the moved tests counted in `integration_common` instead.
  - A Vercel redeploy and a Render redeploy of `Vercel_Integration_test` still go live. This proves
    the sealed keys still open.
- **Docs:** the "Copied from …, keep the copies in step" header comments are removed.

### 2. Scaffold `backend/neondb_integration/`
- From `render_integration`'s skeleton:
  - `package.json` (name `orbitops-neondb-integration`), `tsconfig.json`, `vitest.config.ts`,
    `.gitignore`, `.env.example`, `README.md`;
  - `src/server.ts`, `src/app.ts`, `src/config.ts`, `src/db.ts`, `src/types.ts`,
    `src/test-support/fake-db.ts`.
  - No `deployments/`, `callbacks/` or outbox, because provisioning is synchronous.
- **`config.ts`:**
  - `PORT` 3004, `HOST` 127.0.0.1;
  - `DATABASE_URL`, `ENCRYPTION_KEY`, `NEON_SERVICE_TOKEN`;
  - `NEON_API_BASE` (default `https://console.neon.tech/api/v2`);
  - `NEON_PROVISION_TIMEOUT_MS` (60000);
  - `DEFAULT_REGION` (`aws-us-west-2`), `DEFAULT_PG_VERSION` (17).
- **`prisma/schema.prisma`** (schema `neon`):
  ```prisma
  model NeonCredential {
    id              String    @id @default(cuid())
    userId          String    @unique
    apiKeyEnc       String    @db.Text
    accountName     String    @db.VarChar(255)
    orgId           String?   @db.VarChar(255)   // null = personal account (if the spike allows it)
    orgName         String?   @db.VarChar(255)
    orgs            Json      // [{ id, name }]
    regionId        String    @default("aws-us-west-2") @db.VarChar(50)
    pgVersion       Int       @default(17)
    invalidAt       DateTime?
    lastValidatedAt DateTime
    createdAt       DateTime  @default(now())
    updatedAt       DateTime  @updatedAt
  }
  model NeonDatabase {
    id            String   @id @default(cuid())
    componentId   String   @unique            // the backend's Component.id
    userId        String
    neonProjectId String   @db.VarChar(255)
    name          String   @db.VarChar(64)
    orgId         String?  @db.VarChar(255)
    regionId      String   @db.VarChar(50)
    pgVersion     Int
    branchId      String   @db.VarChar(255)
    databaseName  String   @db.VarChar(255)
    roleName      String   @db.VarChar(255)
    host          String?  @db.VarChar(255)   // display only; no password
    state         String   @db.VarChar(20)    // provisioning | ready | failed
    lastError     String?  @db.Text
    createdAt     DateTime @default(now())
    updatedAt     DateTime @updatedAt
    @@index([userId])
  }
  ```
- The migration `prisma/migrations/2026110x0001_init` is generated offline with
  `prisma migrate diff --from-empty`, as in Phases 6–7.

### 3. Pure helpers + HTTP client — `src/neon/`, each with a unit test
- `project-name.ts`: `<repo>-<component name>`, lowercase, `[a-z0-9-]`, ≤ 64 chars. A random
  4-character suffix on a conflict.
- `regions.ts`:
  - the allowed `region_id`s:
    - AWS: `aws-us-east-1`, `aws-us-east-2`, `aws-us-west-2`, `aws-eu-central-1`, `aws-eu-west-2`,
      `aws-ap-southeast-1`, `aws-ap-southeast-2`, `aws-sa-east-1`;
    - Azure: `azure-eastus2`, `azure-westus3`, `azure-gwc`;
  - labels for the Settings select;
  - pg versions `{15, 16, 17}`.
- `connection.ts`:
  - `systemEnv({ pooledUri, directUri })` → `[{ key: "DATABASE_URL", value: pooledUri },
    { key: "DATABASE_URL_UNPOOLED", value: directUri }]`;
  - `safeHost(uri)` for display, which strips the user and password.
- `operations.ts`: `allFinished(ops)`, `firstFailure(ops)`.
- `neon-http.ts`:
  - `neonRequest(ctx, method, path, opts)`: base `NEON_API_BASE`, `Authorization: Bearer <key>`,
    `Accept: application/json`, `redirect: "error"`, on the shared `providerFetch`;
  - `neonError(response, action)` → `ProviderError`:

    | Neon response | Mapped to |
    |---|---|
    | 401 | 412 `neon_key_invalid` + `invalidToken` |
    | 403 | 403 `neon_forbidden` ("the key cannot use this organization") |
    | 404 on `/projects/:id` | handled by callers |
    | 409, or 422 mentioning the project limit (exact text from step 0) | 409 `neon_project_limit` ("Neon's plan limit is reached: delete a project on Neon or upgrade") |
    | 423 | `neon_locked` (retryable: operations still running) |
    | 429 | `neon_rate_limited` (retryable) |
    | 5xx | 502 `neon_unavailable` (retryable) |
  - Neon's error text is passed through only after `redact()`. A connection string or password must
    never appear in an error.

### 4. `NeonProvider` — `src/neon/neon.provider.ts`
- `validateKey(key)`: `GET /users/me` → `accountName` (name or email), then
  `GET /users/me/organizations` → `orgs`.
- `ensureDatabase(ctx, known, spec, defaults, log)`:
  1. If `known`: `GET /projects/:id`.
     - 200 → wait for operations, then `ready`.
     - 404 → log "the Neon project was deleted on Neon; creating a new, **empty** one", then
       create.
  2. Else create: `POST /projects` with `{ name, region_id, pg_version, org_id? }`.
     - A name taken → suffix and retry once.
     - Save `neonProjectId`, `branchId`, `databaseName` and `roleName` from the response straight
       away (state `provisioning`), **before** waiting. A retry then finds the project instead of
       creating a second one.
  3. `waitForOperations(projectId)`: poll `GET /projects/:id/operations` every 1 s, up to
     `NEON_PROVISION_TIMEOUT_MS`.
     - A 423 is retried.
     - A failed operation → `neon_provision_failed` with its error.
     - A timeout → `neon_provision_timeout`. The row stays `provisioning`, and the next call
       resumes it.
  4. Return `{ neonProjectId, name, regionId, host, databaseName, roleName, consoleUrl:
     "https://console.neon.tech/app/projects/<id>", created: boolean }`.
- `getConnection(ctx, db)`: two calls to `GET /projects/:id/connection_uri` with `database_name`,
  `role_name`, `pooled=true|false` → `{ pooledUri, directUri }`. Never logged.
- `destroy(ctx, db)`: `DELETE /projects/:id`. Implemented, not called by the MVP.

### 5. Credentials — `src/credentials/` (same shape as Render's)
- `save(userId, apiKey)`:
  - validate, `seal`, upsert;
  - the default org is the only org if there is exactly one, else null (or the first, if step 0
    shows `org_id` is required);
  - keep the chosen org if the same account re-saves.
- `setPreferences(userId, { orgId?, regionId?, pgVersion? })`:
  - `orgId` must be in `orgs`, and is locked (409) once a `NeonDatabase` exists;
  - `regionId` and `pgVersion` must be from `regions.ts`; they apply to new databases only.
- `get` → `{ provider: "neon", state: connected|invalid|missing, accountName, orgId, orgName, orgs,
  regionId, pgVersion, scopeLocked, lastValidatedAt }`. Never the key.
- `getKey(userId)` and `markInvalid(userId)`. The latter is called on any `neon_key_invalid`.

### 6. Databases service + internal API — `src/databases/`, `src/app.ts`
- `databases.service.ts`:
  - `ensure(request)` is serialised per `componentId` with a small in-memory lock, using the shared
    `deploy-queue` with concurrency 1 per key. It is idempotent: a ready database returns at once
    with `created: false`.
  - `get(userId, componentId)`.
  - `connection(userId, componentId)`: the database must be `ready` and belong to `userId`, else
    404/409.
  - `destroy(userId, componentId)`.
- **Internal API:**

  | Method & path | Purpose |
  |---|---|
  | `GET /health` | liveness + DB check (no token) |
  | `GET/PUT/PATCH/DELETE /users/:userId/credential` | as in step 5. PUT `{ apiKey }`; PATCH `{ orgId?, regionId?, pgVersion? }` |
  | `POST /databases` | `{ userId, componentId, projectName, componentName }` → waits until ready (≤ 60 s) → `DatabaseView` |
  | `GET /databases/:componentId?userId=` | `DatabaseView` or 404 |
  | `GET /databases/:componentId/connection?userId=` | `{ pooledUri, directUri }`. **The only route that returns secrets.** Sent with `cache-control: no-store`, and the route is excluded from request logging |
  | `DELETE /databases/:componentId?userId=` | delete the Neon project; not called by the MVP |
- `DatabaseView = { componentId, state, neonProjectId, name, regionId, pgVersion, host,
  databaseName, roleName, consoleUrl, created?, lastError }`.
- `server.ts`: graceful shutdown. On boot, a row left `provisioning` simply resumes on its next
  `ensure`; there is no background work.

### 7. Vercel service: accept public env vars (small, inside `vercel_integration`)
- `types.ts`: `DeployRequest.publicEnvVars?: EnvVar[]`, for **non-secret** values only (the API
  URL). They are stored in `StoredDeployInput`, so a resumed run still has them.
- `deploy-input.ts`:
  - validates up to 20 entries, with keys matching `^[A-Z_][A-Z0-9_]*$`;
  - rejects keys containing `SECRET`, `TOKEN`, `KEY` or `PASSWORD` as a guard.
- `prisma/schema.prisma`: `VercelProject.managedEnvKeys Json @default("[]")` and
  `envHash String? @db.VarChar(64)`. A new migration `2026110x0002_public_env`.
- `deploy-runner.ts`, after `ensureProject` and before `deploy`:
  - if the `envHash` changed, call `setEnv` with `type: "plain"` and
    `target: ["production", "preview"]`;
  - delete managed keys that are gone (`DELETE /v9/projects/:id/env/:envId`, which needs a
    `GET /v9/projects/:id/env` lookup, added to the provider);
  - log "Set NEXT_PUBLIC_API_URL on the Vercel project". The value can be logged because it is
    public.
- Tests: the env-hash skip, the stale-key delete, the guard rejecting a secret-looking key.

### 8. Main backend seam
- **Client:**
  - `lib/providers/neon-service.client.ts` (extends `IntegrationServiceClient`):
    - `NEON_SERVICE_URL` (default `http://127.0.0.1:3004`) and `NEON_SERVICE_TOKEN`;
    - unavailable code `neon_service_unavailable`;
    - a 90 s timeout for `ensureDatabase`, 15 s otherwise.
  - Its types go in `lib/providers/neon-service.types.ts`.
  - `lib/runtime.ts` wires `neon`, and the credential-state lambda handles `neon`.
- **Credentials:**
  - `lib/providers/credential-input.ts`:
    - `ConnectableProvider` adds `neon`;
    - `parseNeonPrefsBody` takes `{ orgId?, regionId?, pgVersion? }`;
  - `app/api/providers/[provider]/credential/route.ts`: the PATCH dispatches for `neon`;
  - `app/api/providers/credentials/route.ts`: `lookup("neon")` replaces the hard-coded Phase 8 row.
- **Rules and pre-flight** (`lib/components/provider-rules.ts`, `preflight.ts`):
  - `CAN_DEPLOY` adds `neon`.
  - New `databaseChecks(component, project)` for `kind === "database"`:
    - `engine:<id>`: the framework must be `postgres`/`postgresql` or empty, else fail ("Neon is
      Postgres; this database is mysql").
    - `migrations:<id>` is always `pass`, with advice: "Neon gives the backend `DATABASE_URL`
      (pooled) and `DATABASE_URL_UNPOOLED` (direct). Migrations are not run for you: add
      `npx prisma migrate deploy` (or your ORM's migrate command) to the backend's build command."
      With Prisma, `directUrl = env("DATABASE_URL_UNPOOLED")` is added.
  - `deployable[db.id]` = Neon credential passes + its own checks pass, which drives the
    **Provision** button.
  - `PreflightResult.ok` stays "every check passes", which drives **Deploy all**.
- **`ProviderDeploymentsService`** (`lib/providers/provider-deployments.service.ts`):
  - **Constructor:** gains `neon: NeonServiceClient`, outside `ProviderClients`, because Neon is not
    an event-driven integration.
  - **`provisionDatabase(userId, project, component, options)`**, the `neon` branch of
    `deployComponent`:
    1. Create the `Deployment` row: `provider: "neon"`, `status: running`,
       `providerStatus: "deploying"`, the same commit fields, and `releaseId` when one is given.
    2. Write the section `==> Provisioning Neon database <name>`.
    3. `await neon.ensureDatabase(...)`.
    4. Log `Created Neon project <name> (<region>, Postgres <v>)` or `Neon database <name> is
       ready (existing)`, and the host (no password).
    5. Set `Component.providerResourceId` = the Neon project id, `url` = the console URL,
       `status: live`.
    6. Close the row as `success`.
    7. On error: close the row as `failed` with the message, set `Component.status: failed`,
       re-throw.
  - **`systemEnvFor(userId, project, component)`**:
    - **Render backend:**
      - Look for the project's database component.
      - Not provisioned yet → call `provisionDatabase` first. This keeps a lone **Deploy to Render**
        working, and the extra row shows in history.
      - Then call `neon.getConnection` → `DATABASE_URL` + `DATABASE_URL_UNPOOLED`.
      - Merge them over `projectEnvVars(project)`. If the project already sets one of them, log
        `DATABASE_URL comes from the Neon database; the project's own value is not used.` (the key
        only).
    - **Vercel frontend:** if the project has **exactly one** backend component with a `url`, send
      `publicEnvVars: [{ key: apiUrlKey(component.framework), value: backend.url }]`. Otherwise log
      why it was skipped.
    - Values only ever go into the request body to the integration service. They are never in a log
      line, never in a thrown message, never in the database.
  - **`deployComponent`:**
    - accepts `options.releaseId?` and `options.commitSha` (already there);
    - the "arrives in Phase 8" throw is removed;
    - Neon errors keep their codes: `neon_not_connected`, `neon_key_invalid`.
  - **`reconcile()`:**
    - `neon` rows still `queued`/`running` after a restart call `neon.getDatabase`;
    - `ready` → close as `success`; anything else → `failed` "Provisioning was interrupted; deploy
      again". `ensure` is idempotent, so redeploying is safe.
  - **`handlePush`:** unchanged (databases are never push-deployed). Backends and frontends
    redeployed by a push get `systemEnvFor` automatically.
  - **Terminal hook:** when a `terminal` event closes a deployment that has a `releaseId`, call
    `this.onReleaseStep?.(deployment)`. `ReleasesService` sets this (step 9).
- **New `lib/providers/api-url-env.ts`:** `apiUrlKey(framework)`, the table in Context, unit-tested.
- **Env and config:**
  - `backend/.env.example` adds `NEON_SERVICE_URL` and `NEON_SERVICE_TOKEN`;
  - the backend's `tsconfig.json`, `vitest.config.ts` and `eslint.config.mjs` exclude
    `neondb_integration/**` and `integration_common/**`.

### 9. Releases — "Deploy all"
- **Schema** (`backend/prisma/schema.prisma`, migration `2026110x0003_releases`):
  ```prisma
  enum ReleaseStatus { running success failed cancelled }
  model Release {
    id          String        @id @default(cuid())
    projectId   String
    project     Project       @relation(fields: [projectId], references: [id], onDelete: Cascade)
    number      Int           // per-project sequence, shown as #12
    status      ReleaseStatus @default(running)
    trigger     DeploymentTrigger @default(manual)
    branch      String
    commitSha   String
    commitMessage String?     @db.Text
    /// 0 = databases, 1 = backends, 2 = frontends. The stage now running.
    stage       Int           @default(0)
    errorMessage String?      @db.Text
    createdAt   DateTime      @default(now())
    finishedAt  DateTime?
    deployments Deployment[]
    @@unique([projectId, number])
    @@index([projectId, createdAt])
  }
  // Deployment gains:
  releaseId String?
  release   Release? @relation(fields: [releaseId], references: [id], onDelete: SetNull)
  ```
- **`lib/releases/releases.service.ts`:**
  - `start(userId, projectId)`:
    1. Check ownership.
    2. Refuse if another release of the project is `running`: 409 `release_in_progress`.
    3. Run pre-flight; refuse unless `ok`: 412 `preflight_failed`, with the failing messages.
    4. Resolve **one** commit SHA (`getBranchHeadSha`), so every component builds the same commit.
    5. Create the `Release` (`number` = max + 1 in a transaction).
    6. Emit `releaseChanged`, then `advance(release.id)`.
  - `advance(releaseId)` runs under a per-release lock (the `withLock` pattern from
    `ProviderDeploymentsService`). It is idempotent and works out everything from database rows, so
    it is safe to re-run after a restart:
    1. Stage components: 0 = `database` (neon), 1 = `backend`, 2 = `frontend`. Empty stages are
       skipped.
    2. For the current stage:
       - if it has no Deployment rows, start one per component (`deployComponent` with `releaseId`,
         `commitSha` and `trigger: "manual"`; the database stage runs `provisionDatabase`
         synchronously);
       - if any row is `failed` or `cancelled`: mark the release `failed` or `cancelled`, with
         "Backend failed, so the frontend was not deployed". Later stages are never started.
       - if all rows are `success`: `stage++`, then loop.
       - otherwise (still running): return, because the terminal hook calls back.
    3. After the last stage, set the release to `success` with `finishedAt`.
    4. Each transition writes a release-level line into every running deployment's log:
       `==> Release #12: database ready, deploying backend`.
  - `cancel(userId, releaseId)`: cancel every non-terminal deployment of the release through
    `providerDeployments.cancel`, then mark it `cancelled`.
  - `resumeAll()`, from `lib/runtime.ts` bootstrap after `reconcile()`: call `advance()` for every
    `running` release.
  - `list(userId, projectId, take)` and `get(userId, releaseId)` include the deployments, with
    component kind and name.
- **Events:** `EventsService.releaseChanged(projectId, releaseId, status, stage)` adds a new
  `AppEvent` variant on the same `/api/events` feed.
- **Routes:**

  | Method & path | Purpose |
  |---|---|
  | `POST /api/projects/:projectId/releases` | Deploy all → 202 `Release` |
  | `GET /api/projects/:projectId/releases?take=` | the project's releases, newest first |
  | `GET /api/releases/:releaseId` | one release with its deployments |
  | `POST /api/releases/:releaseId/cancel` | cancel the release |

  The existing `POST /api/projects/:id/deploy` (local Docker) is untouched.

### 10. Frontend
- **`lib/deploy/types.ts`:**
  - `CAN_DEPLOY` adds `neon`;
  - `ProviderCredential` gains `orgId`, `orgName`, `orgs`, `regionId`, `pgVersion`;
  - new `Release` and `ReleaseStatus` types;
  - an `AppEvent` `release` variant.
- **`lib/deploy/client.ts`:**
  - `saveProviderToken` and `setProviderPreferences` accept `"neon"`;
  - new `deployAll(projectId)`, `listReleases(projectId)`, `getRelease(id)` and
    `cancelRelease(id)`.
- **`components/ProviderCredentialCard.tsx`:** a Neon config:
  - "API key", linking to `https://console.neon.tech/app/settings/api-keys`;
  - scope "Organization";
  - **Region** and **Postgres version** selects;
  - the note "Free projects suspend when idle; the first query after a pause takes a moment".
- **`settings/page.tsx`:** the Neon row becomes the real card.
- **`configure/page.tsx`:**
  - The Database card:
    - shows the region, and the state from `Component.status`/`url`;
    - gets a **Provision on Neon** button (the per-component deploy);
    - replaces the "Provisioned on Neon in a later phase" text with the env vars it provides
      (names only) and the migrations advice.
  - The header button:
    - **Deploy all** when `preflight.ok` (calls `deployAll`, then routes to the project page);
    - otherwise, today's "deploy the components that passed".
  - The "Render and Neon arrive in Phases 7 and 8" text is removed.
- **`deploy/[projectId]/page.tsx`:**
  - The Database card shows ● CONNECTED for `live`, **Open on Neon** (the console URL) and the
    region. The "Phase 8" label is removed.
  - A **Releases** strip shows the latest release: `#12 · Database ✓ → Backend ⟳ → Frontend ·`.
    Each step links to `/deploy/builds/<deploymentId>`. There is a Cancel button while running, and
    it updates live from `release` events.
- **`deploy/builds/[deploymentId]/page.tsx`:**
  - no structural change;
  - for `provider === "neon"` the chip reads "Neon · provision" and the link "Open on Neon";
  - a deployment in a release shows "Part of release #12".

### 11. Docs
- **README:**
  - architecture: the four services plus `integration_common`;
  - a Terminal 5 run block for `neondb_integration`;
  - `npm install` order (`integration_common` is linked; run `npm install` inside each service);
  - a **"Neon setup"** section:
    - the API key and organization;
    - region and version;
    - the two env vars;
    - the Prisma `directUrl` snippet;
    - adding migrate to the build command;
    - free-tier limits;
  - a **"Deploy all"** section: the order, and what is injected where;
  - env tables.
- `backend/neondb_integration/README.md` and `backend/integration_common/README.md`.
- `frontend/docs/API_CONTRACT.md`: the Neon credential routes and prefs body, the release routes, the
  `release` event, and the error codes (`neon_*`, `release_in_progress`, `preflight_failed`).
- **`PLAN.md`:**
  - the Phase 8 checklist and status;
  - Phase 11: `Release` ✅ and the per-project sequence number ✅;
  - Phase 12: the orchestration lines ✅;
  - Cross-cutting: `integration_common` ✅.

---

## Out of scope
- Neon branches per PR or preview database; resetting the database.
- Running migrations for the user; seeding.
- Deleting the Neon project when the Database card is removed. `destroy` exists but is not called;
  the UI says the database is kept.
- Injecting the frontend URL into the backend (CORS origin): Phase 9, as a user env var.
- An API URL when a project has several backends.
- Releases triggered by a push. Pushes stay per component, as now.
- Neon OAuth. Rollback of a release (Phase 11). Encrypted per-component env vars (Phase 9).

## Verification
1. **Build hygiene:**
   - `integration_common`: `npx tsc --noEmit && npm test`;
   - `vercel_integration`, `render_integration` and `neondb_integration`: `npx tsc --noEmit && npm test`;
   - `backend` and `frontend`: `npm run typecheck && npm run lint && npm test`;
   - `prisma validate` on all four schemas.

   After step 1 alone, the combined test count of Vercel, Render and common must be ≥ today's
   (96 + 113) with nothing skipped.
2. **Unit tests** (Vitest, `fetch` stubbed, step-0 fixtures replayed):
   - **common:**
     - secret-box opens values sealed by each old copy;
     - provider-fetch honours all three rate-limit headers;
     - the outbox with a fake `PendingEventStore`;
     - callback-client sets the provider header.
   - **neon helpers:** names, regions, `systemEnv`, `safeHost` strips the password, operations.
   - **neon-http:** each status → code; no key and no URI in any error.
   - **provider:**
     - creates once, then reuses;
     - ids are persisted before the wait;
     - a 404 recreates, with a warning;
     - a 423 is retried;
     - a failed operation → `neon_provision_failed`;
     - a timeout leaves `provisioning` and the next call resumes;
     - the name conflict suffix;
     - the project-limit mapping.
   - **credentials:** sealed; org lock; region and version validation; `markInvalid`.
   - **API:**
     - `inject()`: 401 without the token;
     - `/connection` is 404 for another user's component;
     - `/connection` is never written to the Fastify log.
   - **vercel_integration:** `publicEnvVars` is validated, set once per hash, stale keys deleted,
     secret-looking keys rejected.
   - **backend:**
     - `apiUrlKey`.
     - `systemEnvFor`:
       - Render gets both URLs and they override project vars;
       - an unprovisioned DB is provisioned first;
       - Vercel gets the API URL only with exactly one backend.
     - `provisionDatabase` success and failure rows.
     - `reconcile` of neon rows.
     - Pre-flight: the engine check, the Neon credential states, `deployable` for the database.
     - `releases.service.test.ts` (fake clients):
       - stage order;
       - an empty stage is skipped;
       - a failure stops later stages;
       - cancel;
       - `advance` is idempotent (calling it twice starts nothing twice);
       - resume after a restart;
       - 409 when a release is already running;
       - 412 when pre-flight fails.
     - Credential routes accept `neon`; the credentials list shows Neon's real state.
3. **Manual**, with `Robert-547/Vercel_Integration_test`, after adding to it:
   - a `backend/` route `GET /db` that runs `select now()` with `pg` using `DATABASE_URL`;
   - a frontend page that fetches `${NEXT_PUBLIC_API_URL}/db`.

   The checks:
   - **Settings:** a bad Neon key → error. A good key → the org is listed. Set the region and
     version → Connected. The key is not in any response, and it is sealed in
     `neon."NeonCredential"`.
   - **Configure:** the Database card's pre-flight passes, **Provision on Neon** is enabled, and the
     header shows **Deploy all**.
   - **Deploy all:**
     - Release #1 shows Database ✓ (a new project on the Neon console, in Oregon), then Backend
       (Render), then Frontend (Vercel). The Frontend step starts only after the backend is live.
     - `https://<backend>.onrender.com/db` returns a timestamp.
     - The Vercel page shows the same timestamp, fetched from the backend through
       `NEXT_PUBLIC_API_URL`.
     - Neither connection string appears in any of our logs, API responses or tables. Check with
       `grep -r "neon.tech" backend/data/logs` and a DB query.
   - **Deploy all again:** the same Neon project is reused ("ready (existing)"), with no new project
     on the console. Render env vars are unchanged, so no env calls; Vercel's env hash is unchanged.
   - **Push only `backend/`:** only the backend redeploys, and `/db` still works (`DATABASE_URL`
     re-injected).
   - **Per-component Deploy to Render** with the database not yet provisioned: it provisions first
     (two rows in history), then deploys.
   - **Failures:**
     - break the backend's start command, then Deploy all → the release fails at Backend, and the
       frontend is not deployed;
     - cancel a release mid-backend → cancelled on Render too, and the release is `cancelled`.
   - **Restart the main backend** mid-release → after the restart the release carries on to the
     frontend.
   - **Stop `neondb_integration`:**
     - Settings shows "Unavailable";
     - pre-flight fails cleanly;
     - a backend deploy fails with "The Neon integration service is not running".
   - **Remove the Neon key in Settings** → the next backend deploy fails with "Connect Neon in
     Settings".
   - **Second user:** `POST /api/projects/<id>/releases` → 404.
   - **Regression:** the Vercel-only and Render-only deploys and the Docker push-to-deploy still
     work.
