# Phase 6 — Vercel Integration: implementation plan

> **What executing this plan means first:** save this document as
> `Plans/Plans_Remaining/PLAN_PHASE_6.md` (companion to `PLAN_PHASE_5.md`), then work through the
> steps below in order.

> **Status: done and verified live (2026-11-02, re-checked 2026-11-03).** Built following the
> Addendum: all Vercel code is in `backend/vercel_integration/`.
>
> | Item | State |
> |---|---|
> | Steps 1–12, Addendum A1–A8 | ✅ implemented (step 11, push-to-deploy, included) |
> | Step 0, the API spike (`npm run spike`, needs a real Vercel token) | ⬜ not run; `src/vercel/__fixtures__/` is empty, so `isGitAccessError` is not yet tightened |
> | Migrations: backend `202611030001_vercel_provider` and the service's `vercel` schema | ✅ applied |
> | Verification §1, build hygiene | ✅ `vercel_integration` 96 tests, backend 301 tests, all passing (typecheck clean) |
> | Verification §2, unit and contract tests | ✅ passing (stubbed `fetch`; no recorded fixtures yet) |
> | Verification §3, live smoke test (`VERCEL_SMOKE_TOKEN`) | ⬜ not run |
> | Verification §4 and A9, manual | 🟡 the core path passed; the edge cases are not run yet (list below) |
>
> Verification §4, checked live with `Robert-547/Vercel_Integration_test`:
> - ✅ Settings: token connected (the deploys ran under it).
> - ✅ Configure: Frontend → Vercel pre-flight passed; **Deploy** enabled.
> - ✅ Deploy via the **upload fallback**:
>   - Vercel's GitHub app is not installed on the repo, so the project was left unlinked;
>   - the source was downloaded from GitHub, and only the files Vercel lacked were uploaded;
>   - status queued → running → success;
>   - live on `*.vercel.app`: 3 deploys on 2026-11-02 and 1 on 2026-11-03.
> - ✅ Redeploy reuses the same Vercel project; only the changed file is uploaded.
> - ⬜ Not checked yet:
>   - a deploy **with Vercel's GitHub app installed** (git-source path, "Vercel · git");
>   - a git push does not create a deploy on the Vercel dashboard;
>   - a build-command change → PATCH;
>   - a broken build → failed;
>   - cancel mid-build;
>   - restart of either service mid-build → resume (A9);
>   - the service stopped → "not running";
>   - a second user → 404;
>   - `curl` without `x-internal-token` → 401 (covered by unit tests only).
>
> Where the code departs from the text below, and why:
> - **No `DeploymentProvider` interface or `ProviderRegistry` in the main backend.** With the
>   addendum, the provider lives in the service (`src/vercel/vercel.provider.ts`), and the backend's
>   `lib/providers/provider-deployments.service.ts` chooses by `component.provider`. A registry of
>   one entry would add nothing; Render (Phase 7) is where it pays off.
> - **`Deployment.providerEventSeq` was added** (not in A6). It makes callback batches idempotent
>   (at most once, in order) with a single conditional check, so the service can redeliver freely.
> - **`NormalisedStatus` gained `deploying`**, meaning "we are creating the project / starting the
>   deploy, before Vercel has a deployment". The table below maps it to `running`.
> - **No framework pre-flight check in the backend.** The framework map lives in the service; an
>   unknown framework is sent as "Other", and Vercel auto-detects it.
> - **`POST /deployments/:id/redeploy` is not exposed.** `VercelProvider.redeploy` is implemented
>   and tested; Phase 11's rollback UI will add the route.
> - **A cancelled deploy leaves the component `live`** if it had a URL, because the previous Vercel
>   deployment keeps serving. Otherwise it goes back to `configured`.
> - **The service runs TypeScript with `tsx`** (no build step) and uses Fastify 5. Its secret-box,
>   redact and fs-utils are copies of the backend's (A1).
> - **`backend/.env.example` no longer contains a real `ENCRYPTION_KEY`** (step 12).

## Context

`PLAN.md` Phase 6 ("the frontend component deploys to the user's Vercel account") is the first
real provider and the vertical slice the build order calls for ("ship a demo after 6"). Today
every deploy goes through the local Docker path (`DeployExecutor`); nothing talks to an external
host. Phase 6 adds:

- a **provider abstraction** (`DeploymentProvider` + registry) that Render (7) and Neon (8) reuse;
- **per-user provider credentials**, encrypted with the existing `lib/crypto/secret-box.ts`;
- a **`VercelProvider`** that creates/updates a Vercel project for a `Component` and deploys an
  exact commit, either through Vercel's Git integration or, when Vercel is not linked to the
  user's GitHub, by uploading files from our GitHub tarball;
- a **provider runner** that polls Vercel until a terminal state, pipes Vercel's build log into
  our existing log writer and publishes status over the existing `/events` SSE.

**Done when:** on `/deploy/<id>/configure`, clicking **Deploy** on the Frontend → Vercel card puts
a Next.js subfolder live on a `*.vercel.app` URL. The build page streams Vercel's log live, and the
project page shows the component as LIVE with its URL. The local Docker path keeps working
untouched.

### Decisions already made with the user
- **Source:** Git source when Vercel is linked to the repo, with **file upload from our tarball
  as the fallback**. Vercel's own deploy-on-push is switched off, so we own triggering.
- **Records:** **extend the existing `Deployment` table** with nullable provider columns; no new
  `ProviderDeployment` table. Logs, SSE, the history list and the build page keep working.

---

## Prerequisites (from Phase 5)

Phase 5 is in progress and not committed yet. **Already in code:**
- the `Component` model and the `ComponentKind`/`ProviderId`/`ComponentStatus` enums
  (`backend/prisma/schema.prisma:32-53,254`), with migration `202611020001_deployment_configuration`;
- `lib/components/provider-rules.ts` (`PROVIDER_FOR_KIND`, `PROVIDER_LABEL`, `PROVIDER_IDS`);
- `lib/components/component-input.ts` (`parseComponentSet`, `parseUpdateComponent`);
- `lib/components/preflight.ts`: `runPreflight(project, components, deps)`, where
  `deps.hasCredential(userId, provider)` is a stub that returns `pending`.

**Still needed before Phase 6 starts:**
- `lib/components/components.service.ts` (`list`, `replaceAll`, `update`) in `Runtime`;
- the `/api/projects/:id/components*` and `/preflight` routes;
- the `/deploy/[projectId]/configure` page with its disabled **Deploy** button.

Phase 6 swaps the stub for real credentials and turns on the button for Vercel components.

---

## Design decisions

1. **One provider interface, implemented by Vercel first.** `lib/providers/provider.interface.ts`
   follows `PLAN.md`'s sketch, with explicit context objects so each method stays pure and
   testable. Render and Neon reuse the same registry, runner and credential store.
2. **Provider deployments get their own queue instance.** `DeploymentQueue`
   (`lib/deployments/deployment-queue.ts`) has a global cap of `DEPLOY_CONCURRENCY` (default 2),
   sized for local Docker builds. A Vercel job mostly sleeps between status polls, so it must not
   hold one of those two slots. Instead we create a **second `DeploymentQueue`**
   (`providerQueue`, cap `PROVIDER_DEPLOY_CONCURRENCY`, default 8), keyed on
   `component:<componentId>`. Two deploys of the same component are still serialised. The
   constructor gains `{ concurrency, groupKey }` options; the existing queue keeps today's defaults.
3. **`Deployment.status` keeps its five values.** The provider's state goes in a new
   `providerStatus` column (`queued | building | deploying | live | failed | cancelled`). It maps
   onto the lifecycle like this: `building`/`deploying` → `running`, `live` → `success`. The
   frontend `DeploymentStatus` type, `isFinished()` and the bootstrap logic keep working
   unchanged.
4. **Idempotent resource handling.** `ensureResource` always looks up before it creates and writes
   `Component.providerResourceId` **immediately** after a create, before deploying. A retry after
   a crash then finds the project instead of creating a duplicate.
5. **Restarts resume polling instead of failing.** Today `bootstrap()` (`lib/runtime.ts:105`) marks
   every `running` row as failed. For a provider row that already has a `providerDeploymentId`,
   Vercel is still building, so bootstrap re-queues it and the runner resumes polling.
6. **Source mode is chosen per deploy and recorded.** `Deployment.sourceMode = "git" | "upload"`.
   Git mode is used when the Vercel project is linked to the GitHub repo. Otherwise, or if Vercel
   rejects the Git source, the deploy falls back to upload. The fallback is logged, never silent.
7. **Tokens never leave the backend.** Every token is stored sealed. The API returns account
   names only. The writer's `addSecret()` (`deployment-logs.service.ts:55`) is given the token at
   the start of every run.
8. **Credential scope = one Vercel team.** Vercel accounts are team-scoped, and `GET /v2/user`
   returns a `defaultTeamId`. Each credential stores the chosen `teamId`, and every request sends
   `?teamId=`. Changing the team after a component already has a Vercel project returns 409,
   because that project lives in the old team.

---

## Steps

### 0. API spike — settle the open Vercel questions (½ day)

Before writing the provider, use a throwaway Vercel Hobby account and a test repo
(`frontend/` = Next.js, `backend/` = anything) to confirm each of the following. Do it with
`backend/scripts/vercel-spike.ts`, run with `npx tsx`; the token comes from env and is never
committed.

| Question | Call(s) | Record |
|---|---|---|
| Token validation and team list | `GET /v2/user`, `GET /v2/teams` | Response shape; `defaultTeamId` present? |
| Create a project linked to Git | `POST /v11/projects` with `gitRepository: { type: "github", repo: "owner/repo" }`, `rootDirectory`, `framework` | Exact error code/message when Vercel's GitHub app **cannot** see the repo |
| Turn off Vercel's deploy-on-push | `PATCH /v9/projects/:id` `{ gitProviderOptions: { createDeployments: "disabled" } }` | Does a push still deploy? Does our API deploy still work afterwards? |
| Git-source deploy | `POST /v13/deployments` `{ name, project, target: "production", gitSource: { type: "github", repoId, ref, sha } }` | Works on an **unlinked** project? Error code when not allowed |
| Upload deploy | `POST /v13/deployments` with `files[]` → `400 missing_files` → `POST /v2/files` → retry | Missing-files response shape |
| Status | `GET /v13/deployments/:id` | `readyState` values seen, `url`, `alias`, `errorCode`, `errorMessage`, `inspectorUrl` |
| Logs | `GET /v3/deployments/:id/events?builds=1&direction=forward&limit=-1&since=` | Event shape (`type`, `created`, `payload.text`, `payload.serial`/`id`) |
| Cancel | `PATCH /v12/deployments/:id/cancel` | Final `readyState` |
| Framework slugs | `nextjs`, `vite`, `create-react-app`, `nuxtjs`, `sveltekit-1`, `astro`, `angular`, `vue` | All accepted by `POST /v11/projects`? |
| Rate limits | any | `x-ratelimit-*` / `retry-after` headers on a 429 |

Save **redacted** responses as JSON fixtures in `backend/lib/providers/vercel/__fixtures__/`.
The contract tests (Verification §2) replay them. If `createDeployments: "disabled"` turns out
not to exist, use this fallback: **don't link `gitRepository` on the project** and deploy via
`gitSource` only (if the spike shows that works on an unlinked project), or else upload only.
Write down which rule was chosen at the top of `vercel.provider.ts`.

### 1. Schema + migration — `backend/prisma/schema.prisma`

```prisma
/// One user's API token for one provider, sealed with lib/crypto/secret-box.
model ProviderCredential {
  id              String     @id @default(cuid())
  userId          String
  provider        ProviderId
  tokenEnc        String     @db.Text
  /// Provider account identity, for display and for "is this still the same account?".
  accountId       String     @db.VarChar(255)
  accountName     String     @db.VarChar(255)
  /// Vercel scope every request is sent with (`?teamId=`). NULL = personal scope.
  teamId          String?    @db.VarChar(255)
  teamSlug        String?    @db.VarChar(255)
  /// Set when the provider answered 401/403 with this token; cleared on re-save.
  invalidAt       DateTime?
  lastValidatedAt DateTime
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([userId, provider])
}
```

- `User`: add `providerCredentials ProviderCredential[]`.
- `Component`: add `providerMeta Json @default("{}")`. For Vercel it holds
  `{ projectName, teamId, gitLinked: boolean, lastSettingsHash }`.
  `lastSettingsHash` lets `ensureResource` skip a PATCH when nothing changed.
- `Deployment` (the provider fields from the Phase 11 bullet, added now):
  ```prisma
  componentId          String?
  provider             ProviderId @default(local_docker)
  providerDeploymentId String?    @db.VarChar(255)
  providerStatus       String?    @db.VarChar(20)   // NormalisedStatus
  sourceMode           String?    @db.VarChar(10)   // "git" | "upload"
  url                  String?    @db.Text          // unique deployment URL
  inspectorUrl         String?    @db.Text          // Vercel dashboard link
  component Component? @relation(fields: [componentId], references: [id], onDelete: SetNull)
  @@index([componentId, queuedAt(sort: Desc)])
  @@unique([provider, providerDeploymentId])
  ```
  Add `deployments Deployment[]` to `Component`.
- Migration: `npx prisma migrate dev --name vercel_provider`. Existing rows default to
  `provider = local_docker`, so nothing changes for them.

### 2. Provider core — `backend/lib/providers/`

- `provider.interface.ts`:
  ```ts
  export type NormalisedStatus = "queued" | "building" | "deploying" | "live" | "failed" | "cancelled";
  export interface ProviderContext { token: string; teamId: string | null; signal?: AbortSignal }
  export interface AccountInfo { accountId: string; accountName: string; teams: { id: string; slug: string; name: string }[]; defaultTeamId: string | null }
  export interface ResourceResult { resourceId: string; url?: string; meta: Record<string, unknown> }
  export interface DeployInput { component: Component; project: Project; commitSha: string; branch: string; deploymentId: string; log: DeploymentLogWriter }
  export interface DeployResult { providerDeploymentId: string; url?: string; inspectorUrl?: string; sourceMode: "git" | "upload" }
  export interface StatusResult { status: NormalisedStatus; url?: string; productionUrl?: string; errorMessage?: string }
  export interface LogLine { id: string; at: number; stream: "stdout" | "stderr" | "info"; text: string }

  export interface DeploymentProvider {
    readonly id: ProviderId;
    validateCredentials(token: string): Promise<AccountInfo>;
    ensureResource(ctx: ProviderContext, component: Component, project: Project): Promise<ResourceResult>;
    deploy(ctx: ProviderContext, input: DeployInput): Promise<DeployResult>;
    getStatus(ctx: ProviderContext, providerDeploymentId: string): Promise<StatusResult>;
    getLogs(ctx: ProviderContext, providerDeploymentId: string, since?: number): Promise<LogLine[]>;
    cancel(ctx: ProviderContext, providerDeploymentId: string): Promise<void>;
    redeploy(ctx: ProviderContext, component: Component, providerDeploymentId: string): Promise<DeployResult>;
    setEnv(ctx: ProviderContext, resourceId: string, vars: EnvVarInput[]): Promise<void>;
    destroy?(ctx: ProviderContext, resourceId: string): Promise<void>;
  }
  ```
  `cancel` is added to `PLAN.md`'s sketch because the existing Cancel button must reach the
  provider.
- `provider-error.ts`: `class ProviderError extends Error { provider, status, code, retryable }`.
  The `message` is always user-safe and modelled on `GithubError` (`lib/github/http.ts:10`).
  Extend `toErrorResponse` (`lib/api/http-error.ts:36`) to map a `ProviderError` to
  `{ error: code, message }` with its `status`.
- `provider-registry.ts`: `class ProviderRegistry { get(id: ProviderId): DeploymentProvider }`.
  It throws `badRequest("Deploying to <label> arrives in a later phase")` for Render and Neon
  until Phases 7–8 register them.
- `http-client.ts`: a shared `providerFetch()`. It retries with exponential backoff and jitter
  (3 attempts) on 429, 502, 503, 504 and network errors, honours `retry-after` and
  `x-ratelimit-reset`, respects `AbortSignal`, has a 30 s per-request timeout, and never logs
  headers. Render and Neon reuse it.

### 3. Vercel HTTP client — `backend/lib/providers/vercel/vercel-http.ts`

- `vercelRequest<T>(ctx, method, path, { query?, body?, headers?, rawBody? })`:
  - Base URL is `process.env.VERCEL_API_BASE ?? "https://api.vercel.com"`; the override exists
    for tests.
  - Sends `Authorization: Bearer <token>` and appends `teamId` to the query whenever it is set.
  - Built on `providerFetch()`.
- `mapVercelError(response)` → `ProviderError`. The table is in **Error mapping** below.
  - A 401 or 403 also calls `credentials.markInvalid(userId, "vercel")`, so Settings shows
    "Reconnect".

### 4. Credentials — `backend/lib/credentials/`

- `credentials.service.ts` (class, added to `Runtime`):
  - `get(userId, provider)` returns metadata only.
  - `getToken(userId, provider)` → `{ token, teamId }`. It opens the sealed token and throws
    `ProviderError(412, "vercel_not_connected", "Connect Vercel in Settings first.")` when there
    is none, or when `invalidAt` is set.
  - `save(userId, provider, rawToken)`: `registry.get(provider).validateCredentials(rawToken)` →
    seal → upsert. The default team is `teamId = account.defaultTeamId`. Returns the account and
    teams.
  - `setTeam(userId, provider, teamId)`: `teamId` must be in the token's team list. Returns 409 if
    any of this user's components on this provider already has a `providerResourceId`.
  - `remove(userId, provider)` deletes the credential and leaves the Vercel projects alone. The
    UI copy says so.
  - `markInvalid(userId, provider)`
  - `has(userId, provider)`, which replaces the Phase 5 pre-flight stub.
- `credential-input.ts`: hand-written validator in the style of `lib/projects/project-input.ts`.
  The token must be a non-empty single line of at most 200 chars, with unknown keys rejected.
- `VercelProvider.validateCredentials(token)` calls `GET /v2/user` and then `GET /v2/teams`, and
  maps the result to `AccountInfo`.
- Routes (`requireUser` → service → `toErrorResponse`, the pattern of
  `app/api/projects/[projectId]/deploy/route.ts`; `runtime = "nodejs"`, `dynamic = "force-dynamic"`):

  | Method & path | Purpose |
  |---|---|
  | `GET    /api/providers/credentials` | `[{ provider, accountName, teamId, teamSlug, status: connected\|invalid, lastValidatedAt }]` |
  | `PUT    /api/providers/vercel/credential` | `{ token }` → validate + store; returns account + teams |
  | `PATCH  /api/providers/vercel/credential` | `{ teamId }` → change scope |
  | `DELETE /api/providers/vercel/credential` | disconnect |

  Use `/api/providers/[provider]/credential/route.ts` with the provider validated against
  `PROVIDER_IDS`, so Render and Neon add no new routes.

> Before writing any route, read the route-handler guide in `backend/node_modules/next/dist/docs/`
> (`backend/AGENTS.md`: this Next.js 16 has breaking changes).

### 5. `VercelProvider` — `backend/lib/providers/vercel/vercel.provider.ts`

**Pure helpers**, each in its own unit-tested file:
- `vercel-project-settings.ts`: `toProjectSettings(component)` returns:
  - `framework` from `framework-map.ts` (below)
  - `rootDirectory`: `null` for `"."`, otherwise `rootDir`
  - `installCommand`, `buildCommand`: the component's values, or `null` to use Vercel's default
  - `outputDirectory`: **left out for `nextjs` and `nuxt`**, because Vercel's builders own it and
    setting `.next` breaks the build; the component's value otherwise
  - `nodeVersion`: the major version plus `.x` if it is in `{18, 20, 22, 24}`; left out otherwise

  Plus `settingsHash()`.
- `framework-map.ts` maps our detection ids (`lib/analysis/build-settings.ts`) to Vercel presets:

  | Our id | Vercel preset |
  |---|---|
  | `nextjs` | `nextjs` |
  | `nuxt` | `nuxtjs` |
  | `react` | `create-react-app` when `outputDir === "build"`, else `vite` |
  | `vite` | `vite` |
  | `vue` | `vue` |
  | `sveltekit` | `sveltekit-1` |
  | `astro` | `astro` |
  | `angular` | `angular` |
  | anything else | `null` ("Other"; pre-flight warns) |

  The spike (step 0) confirms the presets.
- `project-name.ts`: `vercelProjectName(repo, componentName)` is lowercase, limited to
  `[a-z0-9-]`, has no `---`, and is at most 100 chars. On a 409 it appends a 4-char random
  suffix.
- `status-map.ts`: `readyState` → `NormalisedStatus`. The table is in **Status mapping** below.
- `log-map.ts`: Vercel event → `LogLine`.
  - Keeps `stdout`, `stderr`, `command` (prefixed `$ `) and `fatal`.
  - Drops `delimiter` and the runtime/edge invocation events.
  - Uses `payload.id ?? serial` as the id, for dedupe.

**Methods:**
- `ensureResource(ctx, component, project)`:
  1. If `component.providerResourceId` is set: `GET /v9/projects/:id`.
     - 404 (the user deleted it on Vercel): clear the id and fall through to create, with a log
       line.
     - Otherwise, if `settingsHash` changed: `PATCH /v9/projects/:id` with the settings.
  2. Otherwise, create:
     - `POST /v11/projects` with `{ name, ...settings, gitRepository: { type: "github", repo: project.repoFullName } }`.
     - If Vercel answers with the spike-recorded "GitHub app has no access / not installed"
       error, retry **without** `gitRepository` and set `gitLinked = false`.
     - If the name is taken (409), use a suffixed name and retry once.
  3. If `gitLinked`: `PATCH /v9/projects/:id { gitProviderOptions: { createDeployments: "disabled" } }`
     (or the rule the spike settled on).
  4. Return `{ resourceId, meta: { projectName, teamId, gitLinked, lastSettingsHash } }`. The
     **runner persists it straight away**.
- `deploy(ctx, input)`:
  - **Git mode** (`meta.gitLinked`):
    - `POST /v13/deployments?skipAutoDetectionConfirmation=1` with
      `{ name, project: resourceId, target: "production", gitSource: { type: "github", repoId: project.repoId, ref: branch, sha }, meta: { orbitopsDeploymentId } }`.
    - If Vercel rejects the Git source (the spike-recorded codes): log
      `==> Vercel cannot read the repo through its GitHub app; uploading files instead` and switch
      to upload mode.
  - **Upload mode**: `uploadSource()` (step 6), then
    `POST /v13/deployments` with `{ name, project, target: "production", files, meta }`.
  - Returns `{ providerDeploymentId: body.id, url: "https://" + body.url, inspectorUrl, sourceMode }`.
- `getStatus`: `GET /v13/deployments/:id` → `status-map`.
  - When live, `productionUrl` is the first entry of `alias[]` that ends in `.vercel.app`, or
    `https://<projectName>.vercel.app`.
  - `errorMessage` is `errorMessage ?? errorCode`.
- `getLogs(ctx, id, since)`: `GET /v3/deployments/:id/events?builds=1&direction=forward&limit=-1&since=<since>` → `log-map`.
- `cancel`: `PATCH /v12/deployments/:id/cancel`. It ignores 400 "already finished".
- `redeploy(ctx, component, oldId)`: `POST /v13/deployments` with
  `{ name, project, deploymentId: oldId, target: "production" }`. It is implemented and tested
  here; the rollback UI is Phase 11.
- `setEnv(ctx, resourceId, vars)`: `POST /v10/projects/:id/env?upsert=true` with
  `[{ key, value, type: "encrypted", target: ["production", "preview"] }]`. It is implemented
  and tested here; Phase 9 calls it.
- `destroy`: `DELETE /v9/projects/:id`. It is implemented but **not called automatically** in
  the MVP (see Out of scope).

### 6. Upload fallback — `backend/lib/providers/vercel/vercel-upload.ts`

`uploadSource(ctx, { github, project, sha, workDir, log, signal })`:
1. `downloadSource(github, parsedRepo, sha, project.installationId, workDir)`
   (`lib/github/source-archive.ts:20`), at the exact SHA.
2. Walk with `walkSourceTree` (`source-archive.ts:41`, which already skips symlinks). Keep blobs
   and drop `.git/`, `node_modules/`, `.vercel/`, `.next/`, `dist/` and `.env*`, except
   `.env.example`.
   - The **whole repo** is uploaded, not just `rootDir`, so monorepo workspaces resolve. Vercel
     applies the project's `rootDirectory`.
   - Limits: at most 15,000 files and 100 MB in total. Over either limit, fail with a clear
     message suggesting "Install Vercel's GitHub app on this repo instead".
3. Hash every file (sha1, streamed) → `files: [{ file, sha, size }]`. Paths use `/`, which
   matters on Windows.
4. Create the deployment first. On `400 missing_files`, upload only the listed SHAs:
   - `POST /v2/files` with headers `x-vercel-digest: <sha>`, `content-length` and
     `content-type: application/octet-stream`, and a stream body.
   - 6 uploads at a time, using the same bounded-concurrency style as detection.
   - Then create the deployment again, at most twice.
5. Log progress (`==> Uploading 214 files (3.1 MB) to Vercel`).
6. `removeDir(workDir)` in `finally` (`lib/common/fs-utils.ts`).

### 7. Provider runner + queue + bootstrap

- `deployment-queue.ts`:
  - The constructor takes `{ concurrency?, groupKey?(job) }`. Defaults keep today's behaviour,
    so the env-var cap and `project:<id>` grouping are unchanged for Docker.
  - `QueueJob` gains an optional `componentId`.
- `backend/lib/deployments/provider-runner.service.ts`: `ProviderRunner.run(job, signal)`, the
  provider counterpart of `DeployExecutor.run`:
  1. Load the deployment with its component and project. Open the log writer
     (`logs.open(projectId, deploymentId)`). Get the token with `credentials.getToken` and call
     `writer.addSecret(token)`.
  2. If `providerDeploymentId` is already set, this is a **resume after restart**: skip to
     step 5.
  3. Mark the deployment `running` with `providerStatus = "deploying"`, emit
     `deploymentChanged`, and set `Component.status = deploying`.
     - Resolve the commit: use `deployment.commitSha`, or else `github.getBranchHeadSha`
       (`github-app.service.ts:252`). Persist it, with the commit message if it is cheap to get.
     - Section `==> Preparing Vercel project <name>` → `ensureResource` → **persist**
       `Component.providerResourceId` and `providerMeta` straight away.
  4. Section `==> Deploying <sha7> to Vercel (git|upload)` → `deploy`. Persist
     `providerDeploymentId`, `sourceMode`, `url` and `inspectorUrl`, and log the inspector link.
  5. **Poll loop** until a terminal status, `signal.aborted`, or a deadline of
     `VERCEL_DEPLOY_TIMEOUT_MIN` (default 45):
     - `getStatus`. If the status changed, update `providerStatus` and emit `deploymentChanged`.
     - `getLogs(since = lastEventAt)`. Dedupe by id and `writer.write(text)` each line.
     - Wait 3 s, rising to 10 s by ×1.5 (`VERCEL_POLL_INTERVAL_MS` sets the base).
     - Transient `ProviderError`s (`retryable`) are logged and retried; a 401 stops the run.
  6. Terminal handling:
     - **live**: Deployment `success`; Component `status = live`, `url = productionUrl`.
       Section `==> Live at https://…`.
     - **failed**: Deployment `failed` with `errorMessage` from Vercel; Component
       `status = failed`.
     - **aborted**: if a `providerDeploymentId` exists, call `cancel()`. Deployment `cancelled`.
     - **timeout**: `failed` with "Vercel did not finish within 45 min; see the Vercel dashboard
       link above."
     - In every case: `logTail = writer.tailText()`, then `writer.close(status)`,
       `finishedAt`, `events.deploymentChanged` and `events.projectChanged(projectId, "updated")`.
       Reuse the shape of `DeployExecutor.finish` / `handleFailure` (`deploy-executor.service.ts:216,258`).
- `lib/runtime.ts`:
  - Build `credentials`, `providers` (registry with `new VercelProvider(github)`),
    `providerQueue` and `providerRunner`, and call
    `providerQueue.setRunner((job, s) => providerRunner.run(job, s))`.
  - Add them to `Runtime`.
- `bootstrap()`:
  - The `running` → failed sweep only touches `provider = local_docker`, plus provider rows
    **without** a `providerDeploymentId`.
  - Re-queue provider rows that are `queued`, and provider rows that are `running` **with** a
    `providerDeploymentId`, onto `providerQueue`.
  - Docker rows go to `queue` as today.
- Shutdown (`registerShutdownHooks`) drains both queues. When a provider job is aborted by a
  shutdown, it **does not** cancel the deploy on Vercel: it leaves the row `running` so the next
  boot resumes it. A `shutdown` flag passed by `drain()` distinguishes this from a user cancel.

### 8. Deploy API — `lib/deployments/deployments.service.ts` + routes

- `deployComponent(userId, projectId, componentId, { trigger, commitSha? })`:
  - Ownership: the 404-for-not-yours rule.
  - The component must have `provider !== local_docker`, and the project must have `repoId`,
    `repoFullName`, `installationId` and a branch. It does **not** need the Docker-only
    `getDeployableProject` fields (slug, hostPort).
  - `credentials.has(userId, provider)`, otherwise 412 `vercel_not_connected`.
  - Creates a `queued` Deployment with `componentId` and `provider`, adds it to `providerQueue`,
    and emits. `trigger` reuses `DeploymentTrigger` (`manual` / `push`).
- `cancel(id)`: pick the queue by `deployment.provider`. If the job is not in memory but has a
  `providerDeploymentId`, call `provider.cancel` directly and mark the row cancelled.
- `listForProject` / `findOne` return the new columns; the routes serialise them as-is.
- New routes:

  | Method & path | Purpose |
  |---|---|
  | `POST /api/projects/:id/components/:cid/deploy` | queue a provider deploy → `202 Deployment` |
  | `GET  /api/projects/:id/components/:cid/deployments` | per-component history (`take=20`) |

  The existing `/api/deployments/:id`, `/cancel`, `/logs` and `/logs/stream` work unchanged.
  Check that the ownership check in `lib/deployments/access.ts` still holds.

### 9. Pre-flight upgrade — `lib/components/preflight.ts`

- Replace `PreflightDeps.hasCredential(): Promise<boolean>` with
  `credentialState(userId, provider): Promise<"connected" | "invalid" | "missing">`, backed by
  `credentials.get`. Give the check a status:
  - **Vercel connected:** `pass`.
  - **Invalid:** `fail` "Vercel rejected the saved token — reconnect in Settings".
  - **Render/Neon:** stay `pending` until Phases 7 and 8.
- New Vercel checks, scoped to each component:
  - **framework supported**: `framework-map` returns `null` → `pass` with the message "Vercel will
    auto-detect".
  - **commands sane**: `buildCmd` present for non-Next frameworks, otherwise a warning.
- `PreflightResult` gains `deployable: Record<componentId, boolean>`, so the UI can enable
  **Deploy** per component. The project-wide `ok` stays for Phase 8's "Deploy all".

### 10. Frontend

Read `frontend/node_modules/next/dist/docs/` first (`frontend/AGENTS.md`).

- `frontend/lib/deploy/types.ts`:
  - Add to `DeployRun`: `componentId`, `provider`, `providerStatus`, `sourceMode`, `url`,
    `inspectorUrl`.
  - New types: `ProviderCredentialInfo`, `VercelAccount`, `ProviderStatus`.
- `frontend/lib/deploy/client.ts` (same `withSession` pattern): `listProviderCredentials`,
  `saveProviderToken(provider, token)`, `setProviderTeam`, `disconnectProvider`,
  `deployComponent(projectId, componentId)`, `listComponentRuns`.
- **Settings → Integrations** (`frontend/app/(dashboard)/settings/page.tsx`, currently a static
  mock):
  - Replace the hardcoded rows with real ones. GitHub uses the existing `/auth/me`
    `githubConnected` flag; Vercel uses a new `components/ProviderCredentialCard.tsx`.
  - Not connected: a password `<input>` for the token, a "Create a token on Vercel ↗" link
    (`https://vercel.com/account/tokens`) and **Connect**. Errors show in `form-error`.
  - Connected: account name, a team `<select>` (disabled with a hint when locked), a
    "Connected"/"Reconnect" `StatusPill`, and **Disconnect**, which asks for confirmation and
    notes that Vercel projects are kept.
  - Render and Neon rows show "Available in Phase 7/8".
  - While doing this, split the one-line JSX (`settings/page.tsx:18`) into readable markup.
- **Configure page** (`deploy/[projectId]/configure/page.tsx`, from Phase 5):
  - **Deploy** is enabled on the Frontend card when `preflight.deployable[cid]`. It calls
    `deployComponent`, then `router.push("/deploy/builds/<runId>")`.
  - A missing credential shows the inline link "Connect Vercel in Settings".
- **Project page** (`deploy/[projectId]/page.tsx`): a "Components" panel with one card per
  component:
  - Kind, provider and a `StatusPill` for `Component.status`.
  - The live URL (↗), the last deploy (commit, when, duration) and **Redeploy**.
  - The Builds table gains a "Component" column.
  - Refreshes through `useAppEvents` (`frontend/lib/deploy/useAppEvents.ts`).
- **Build page** (`deploy/builds/[deploymentId]/page.tsx`):
  - Header chips: provider ("Vercel"), source mode, and a "View on Vercel ↗" link
    (`inspectorUrl`).
  - On success: an "Open site ↗" button (`url`).
  - The log SSE already works unchanged.
- `frontend/components/ui/StatusPill.tsx`: add `building` (blue) and `live` (green) tones.
  Add `pillStatus` handling for `providerStatus`.
- `Icon.tsx`: add a `key` icon for the token field (optional).

### 11. Push-to-deploy for Vercel components (stretch — can move to Phase 11)

Without this, a push no longer deploys the frontend anywhere, because we turned off Vercel's
deploy-on-push.

- In `DeploymentsService.handlePush`, for each matched project, also enqueue `deployComponent`
  (trigger `push`, `commitSha` from the payload, `deliveryId` for dedupe). This applies to every
  `vercel` component that already has a `providerResourceId` and whose `rootDir/**` matches the
  changed files, using `push-filter.ts`'s matcher.
- Docker push behaviour is unchanged. If time is short, mark this ⬜ under Phase 11 in `PLAN.md`
  and say so in the README.

### 12. Docs + config

- `backend/.env.example` and the README "Environment" table: `VERCEL_API_BASE` (optional),
  `PROVIDER_DEPLOY_CONCURRENCY` (8), `VERCEL_POLL_INTERVAL_MS` (3000),
  `VERCEL_DEPLOY_TIMEOUT_MIN` (45). Note that `ENCRYPTION_KEY` now also seals provider tokens.
  `backend/.env.example` currently holds what looks like a real `ENCRYPTION_KEY`: replace it with
  a placeholder and a generation hint (`openssl rand -base64 32`). Any `.env` that copied that key
  must use a fresh one, because provider tokens will now be sealed with it.
- README: a new **"Vercel setup"** section in the style of "GitHub App setup":
  1. Create a token at vercel.com/account/tokens (scope: your team, no expiry for dev).
  2. Paste it in Settings → Integrations.
  3. *Recommended:* install **Vercel's GitHub app** on the repo, which enables Git-source deploys
     and commit links in Vercel. Without it, deploys upload files, which is slower and limited to
     100 MB / 15k files.
  4. We switch off Vercel's own deploy-on-push for projects we create, so deploy from our
     dashboard.

  End with a warning that the token is a credential.
- `frontend/docs/API_CONTRACT.md`: add a "Providers & Vercel deploys" section with the credential
  and component-deploy routes, the new `DeployRun` fields, and the error table below. Use the
  same table + `jsonc` style as "Repository analysis".
- `PLAN.md`: tick the Phase 6 bullets, update "Status as of", and note under Phase 11 that the
  provider columns have landed.

---

## Error mapping (Vercel → `ProviderError`)

| Vercel response | `status` / `code` | User-facing message |
|---|---|---|
| 401, or 403 `forbidden` on any call | 412 `vercel_token_invalid` | "Vercel rejected the saved token. Reconnect Vercel in Settings." (+ `markInvalid`) |
| 403 on a team call | 403 `vercel_team_forbidden` | "This token cannot access the selected Vercel team." |
| 404 project | handled in `ensureResource` (recreate) | — |
| 409 project name | handled (suffix + retry) | — |
| 400 Git-source / GitHub-app errors (codes from the spike) | handled → upload fallback | logged |
| 400 `missing_files` | handled in upload flow | — |
| 402 / plan or rate limit (`deployments_per_day` etc.) | 429 `vercel_limit` | "Vercel's plan limit was reached: <Vercel message>." |
| 429 after retries | 429 `vercel_rate_limited` | "Vercel is rate-limiting requests; try again in a minute." |
| 5xx / network after retries | 502 `vercel_unavailable` | "Could not reach Vercel." |

## Status mapping (`readyState` → `NormalisedStatus` → `Deployment.status`)

| Vercel | Normalised | Deployment.status |
|---|---|---|
| *(before `POST /deployments` returns)* | `deploying` | `running` |
| `QUEUED` | `queued` | `running` (the job is ours and in flight) |
| `INITIALIZING`, `BUILDING` | `building` | `running` |
| `READY` | `live` | `success` |
| `ERROR` | `failed` | `failed` |
| `CANCELED` | `cancelled` | `cancelled` |

## Out of scope (later phases)

- Render and Neon providers (7, 8), and "Deploy all" ordering (8).
- Encrypted per-component env vars and calling `setEnv` (9).
- Rollback UI via `redeploy` and the per-project sequence numbers (11).
- Preview deployments per PR, custom domains, Vercel OAuth Integration (post-MVP).
- Calling `destroy` when a project or component is deleted. For now, deleting keeps the Vercel
  project, and the delete dialog says so.

---

## Verification

1. **Build hygiene:** `cd backend && npx prisma migrate dev` applies cleanly, then
   `npm run typecheck && npm run lint && npm test`. Same for `frontend`.
2. **Unit and contract tests** (vitest; `fetch` stubbed in the style of
   `lib/github/github.service.test.ts`; replaying the step-0 fixtures):
   - `framework-map.test.ts`, `vercel-project-settings.test.ts` (no `outputDirectory` for Next,
     `"."` → `null` root, node version mapping), `project-name.test.ts`, `status-map.test.ts`,
     `log-map.test.ts`.
   - `vercel-http.test.ts`: `teamId` appended; retry on 429 honouring `retry-after`; a 401 maps
     to `vercel_token_invalid`; the token never appears in error messages.
   - `vercel.provider.test.ts`:
     - `ensureResource` creates once and then PATCHes only when the hash changes.
     - A 404 recreates the project.
     - A Git-link failure falls back to an unlinked project.
     - A name conflict gets a suffix.
     - A rejected Git source falls back to upload.
   - `vercel-upload.test.ts` (temp dir fixture): ignore list; only the `missing_files` SHAs are
     uploaded; the file and size limits; POSIX paths.
   - `credentials.service.test.ts`: the token is stored sealed (not plaintext); `get` never
     returns it; changing team is blocked once a resource exists; `markInvalid` makes `getToken`
     throw.
   - `provider-runner.test.ts` (fake provider):
     - The happy path ends `success` and sets `Component.url`.
     - It resumes from an existing `providerDeploymentId`.
     - Abort calls `cancel`.
     - Timeout ends `failed`.
     - Duplicate log events are written once.
     - `providerResourceId` is persisted before `deploy` is called.
   - `deployment-queue.test.ts`: custom `groupKey` / `concurrency`; existing behaviour unchanged.
   - `preflight.test.ts`: credential states map to pass/fail; `deployable` is per component.
3. **Opt-in live smoke test**: `VERCEL_SMOKE_TOKEN=… npm run test:smoke`, skipped without the
   token. It creates a throwaway project, deploys a tiny static fixture by upload, waits for
   READY, then calls `destroy`.
4. **Manual end-to-end**, with backend and frontend running and a test repo with `frontend/`
   (Next.js) and `backend/`:
   - Settings → paste a **bad** token → clear error. Paste a valid one → account name and team
     shown. Reload → still connected. No token in any API response (check the Network tab) and
     no token in the DB in plaintext.
   - Configure → the Frontend → Vercel card's pre-flight passes, and **Deploy** is enabled.
     Backend → Render is still pending.
   - Deploy **with Vercel's GitHub app installed** on the repo:
     - The build page shows "Vercel · git" and streams the Vercel log live.
     - Status moves queued → running → success.
     - The project page shows the Frontend LIVE with a `https://<name>.vercel.app` URL that opens.
     - A git push to the repo does **not** create a deploy on the Vercel dashboard.
   - Uninstall Vercel's GitHub app from that repo and deploy again → the log shows the upload
     fallback, and it still goes live.
   - Re-deploy with no config change → no project PATCH, and the same Vercel project is reused.
     Change the build command → PATCH, then deploy.
   - Break the build (bad build command) → `failed` with Vercel's error message, and the
     component is shown as failed.
   - Cancel mid-build → cancelled both here and on Vercel.
   - Restart the backend mid-build → after restart, the row resumes polling and finishes (not
     "Interrupted").
   - Second user: `POST /api/projects/<id>/components/<cid>/deploy` → 404.
   - The existing Docker push-to-deploy on the Docker test repo still works.

---

## Addendum — Vercel integration as a separate microservice (`backend/vercel_integration/`)

**Constraint (from the user):** all Vercel integration code goes in a new folder,
`backend/vercel_integration/`, which runs as **its own microservice**. Where this addendum
conflicts with the steps above, the addendum wins. The behaviour, Vercel API calls, mapping
tables, error/status tables and tests above all still apply. What changes is **where the code
lives** and **how the two services talk**.

### A1. Shape of the service

- A standalone Node 22 + TypeScript service with its own `package.json`, `tsconfig.json`,
  `vitest.config.ts`, `.env.example` and `README.md`.
  - It is **not** a Next.js app: it uses **Fastify**, a small HTTP server with no frontend.
  - It listens on `127.0.0.1:3002` by default (`PORT`), next to the main backend on `:3001`.
- It has **no imports from `backend/lib/**`**. The few helpers it needs are copied in, so the
  service builds and deploys on its own:
  - `secret-box.ts`
  - `redact.ts`
  - the tarball download from `source-archive.ts`
- **Data:** it uses the same Postgres instance, but in its **own schema** (`vercel`), with its own
  Prisma schema and migrations at `vercel_integration/prisma/`. The connection string is
  `DATABASE_URL=...?schema=vercel`. It never reads or writes the main backend's tables, and the
  main backend never reads or writes its tables.
- **Dev:** `cd backend/vercel_integration && npm install && npx prisma migrate dev && npm run dev`
  (`tsx watch src/server.ts`). The main backend's README lists both processes. If one gets added,
  a root-level `npm run dev:all` starts them together.

### A2. Folder layout

```text
backend/vercel_integration/
├── package.json  tsconfig.json  vitest.config.ts  .env.example  README.md
├── prisma/schema.prisma            # schema "vercel": VercelCredential, VercelProject, VercelDeployment
└── src/
    ├── server.ts                   # Fastify bootstrap, internal-auth hook, graceful shutdown, resume on boot
    ├── config.ts                   # env loading + validation (fails fast on missing vars)
    ├── auth/internal-auth.ts       # constant-time check of the x-internal-token header
    ├── crypto/secret-box.ts        # copy of backend/lib/crypto/secret-box.ts
    ├── common/redact.ts            # copy of backend/lib/common/redact.ts
    ├── http/provider-fetch.ts      # retries/backoff/timeout (step 2 http-client)
    ├── http/provider-error.ts      # ProviderError (step 2)
    ├── vercel/vercel-http.ts       # step 3
    ├── vercel/framework-map.ts  project-settings.ts  project-name.ts  status-map.ts  log-map.ts
    ├── vercel/vercel.provider.ts   # step 5
    ├── vercel/vercel-upload.ts     # step 6 (tarball download with a token passed in by the backend)
    ├── credentials/credentials.service.ts  credential-input.ts   # step 4
    ├── deployments/deploy-queue.ts        # per-component serialisation (decision 2)
    ├── deployments/deploy-runner.ts       # step 7's poll loop, logs, terminal handling
    ├── deployments/deployments.service.ts
    ├── callbacks/callback-client.ts       # signed, retried event delivery to the main backend
    └── routes/ health.ts  credentials.ts  deployments.ts  projects.ts
    (every *.ts has a sibling *.test.ts; fixtures in src/vercel/__fixtures__/)
```

### A3. Who owns what

| Concern | Owner | Notes |
|---|---|---|
| Vercel tokens (sealed), team scope, invalid flag | **microservice** (`VercelCredential`) | Replaces the main-schema `ProviderCredential` model from step 1 |
| Vercel project per component (`projectId`, name, teamId, gitLinked, settingsHash) | **microservice** (`VercelProject`, keyed by the main `componentId`) | Replaces `Component.providerMeta` from step 1 |
| Vercel deployment state (`vercelDeploymentId`, readyState, sourceMode, lastEventAt, callback seq) | **microservice** (`VercelDeployment`, keyed by the main `deploymentId`) | |
| Queueing, polling, log fetching, cancel, restart-resume | **microservice** | Replaces the second `DeploymentQueue` and `ProviderRunner` in the main backend (step 7) |
| `Deployment` rows, the log file, `/events` SSE, `/logs/stream`, ownership checks | **main backend** | Updated from the microservice's callbacks |
| GitHub App (installation token, branch head SHA) | **main backend** | Passes a short-lived installation token to the microservice per deploy |
| User session / auth | **main backend** | The microservice trusts only the main backend (shared secret), never the browser |

### A4. Internal API (main backend → microservice)

Every request carries `x-internal-token: <INTERNAL_SERVICE_TOKEN>`, which is compared in constant
time. Anything else gets 401. The service binds to `127.0.0.1` only. `userId` is always supplied
by the main backend after its own session check.

| Method & path | Purpose |
|---|---|
| `GET    /health` | liveness + DB check (no auth) |
| `GET    /users/:userId/credential` | `{ state: connected\|invalid\|missing, accountName, teamId, teamSlug, teams, lastValidatedAt }` — never the token |
| `PUT    /users/:userId/credential` | `{ token }` → `GET /v2/user` + `/v2/teams` → seal → upsert |
| `PATCH  /users/:userId/credential` | `{ teamId }` (409 once any `VercelProject` exists for this user) |
| `DELETE /users/:userId/credential` | disconnect (Vercel projects are kept) |
| `POST   /deployments` | `{ deploymentId, userId, component: { id, name, rootDir, framework, installCmd, buildCmd, outputDir, nodeVersion }, repo: { fullName, repoId, branch }, commitSha, githubToken }` → `202`; enqueues |
| `GET    /deployments/:deploymentId` | current state (used for reconciliation) |
| `POST   /deployments/:deploymentId/cancel` | abort locally + `PATCH /v12/deployments/:id/cancel` |
| `GET    /deployments?state=active` | non-terminal deployments (reconciliation after a main-backend restart) |
| `POST   /deployments/:deploymentId/redeploy` | Phase 11 hook (implemented, not wired to UI) |
| `PUT    /components/:componentId/env` | Phase 9 hook → `setEnv` |
| `DELETE /components/:componentId` | `destroy` (implemented, not called in the MVP) |

`githubToken` is a GitHub App installation token minted by the main backend (valid for about 1
hour), used only for the upload fallback's tarball download. It is never stored or logged, and it
is added to the redaction list for that run.

### A5. Callbacks (microservice → main backend)

- `POST {MAIN_API_URL}/api/internal/provider-events`. The body is
  `{ deploymentId, seq, events: [...] }`, signed with
  `x-orbitops-signature: sha256=<HMAC(INTERNAL_CALLBACK_SECRET, rawBody)>`.
- Event kinds:
  - `status`: `{ providerStatus, deploymentStatus, errorMessage? }`
  - `resource`: `{ componentId, providerResourceId, projectName }`
  - `deployment`: `{ providerDeploymentId, sourceMode, url, inspectorUrl }`
  - `logs`: `{ lines: [{ at, stream, text }] }`, batched up to every 1 s or 200 lines
  - `terminal`: `{ status, productionUrl?, errorMessage? }`
- **Delivery:**
  - Callbacks for one deployment go in order, with `seq` increasing.
  - Failures are retried with backoff for up to 10 minutes. Undelivered batches are kept in
    `VercelDeployment.pendingEvents`, so a microservice restart does not lose them.
- **Main-backend handling is idempotent:** it ignores any `seq` ≤ the last applied one, which it
  tracks in memory per deployment and falls back to `Deployment.providerStatus` for.

### A6. What still has to change outside `vercel_integration/` (the unavoidable seam, kept minimal)

These are the only edits to existing code. Each is small and has no Vercel-specific logic:
1. **`backend/prisma/schema.prisma`:** only the `Deployment` provider columns from step 1
   (`componentId`, `provider`, `providerDeploymentId`, `providerStatus`, `sourceMode`, `url`,
   `inspectorUrl`). **No** `ProviderCredential` model and **no** `Component.providerMeta`.
2. **`backend/lib/providers/vercel-service.client.ts`:** a typed `fetch` client for A4 (base URL
   `VERCEL_SERVICE_URL`, header `INTERNAL_SERVICE_TOKEN`, 10 s timeout). Errors are mapped to
   `HttpError`, with the microservice's `{ error, message }` passed through.
3. **`DeploymentsService.deployComponent` / `cancel`** (step 8):
   - Create the queued row, resolve `commitSha` with `getBranchHeadSha`, mint the installation
     token, then `POST /deployments`.
   - If the microservice is unreachable, mark the row `failed` with "Vercel integration service
     is not running".
   - No second queue in the main backend.
4. **`backend/app/api/internal/provider-events/route.ts`:**
   - Verify the HMAC over the raw body (reuse `lib/webhooks/signature.ts`).
   - Apply each event to `Deployment`/`Component`.
   - Write log lines through a `DeploymentLogWriter` kept open per active deployment. The writer
     appends, and is reopened after a restart. Call `writer.close(status)` on `terminal`.
   - Emit `events.deploymentChanged` / `projectChanged`.
5. **Thin proxy routes:**
   - `/api/providers/[provider]/credential` (GET/PUT/PATCH/DELETE) and
     `/api/projects/:id/components/:cid/deploy`: `requireUser`, then the ownership check, then
     forward to the microservice with `user.id`.
   - The frontend still talks only to the main backend (same origin, same session cookie).
6. **Pre-flight (step 9):** `credentialState` calls `GET /users/:userId/credential`. If the
   microservice is unreachable, the check is `fail` "Vercel integration service is not running".
7. **`lib/runtime.ts` bootstrap:**
   - Rows with `provider !== local_docker` are **excluded** from the "running → failed" sweep and
     from the Docker re-queue, because the microservice owns them.
   - After boot, reconcile: `GET /deployments?state=active`, and apply the state of any row the
     main backend still shows as non-terminal.
8. **Frontend (step 10):** unchanged. It never sees the microservice.

### A7. New environment variables

| Where | Variable | Purpose |
|---|---|---|
| `vercel_integration/.env` | `PORT` (3002), `DATABASE_URL` (`?schema=vercel`) | server + own schema |
| | `ENCRYPTION_KEY` | seals Vercel tokens. Its own key, separate from the main backend's |
| | `INTERNAL_SERVICE_TOKEN` | expected on every inbound request |
| | `MAIN_API_URL` (`http://localhost:3001`), `INTERNAL_CALLBACK_SECRET` | callback target + HMAC key |
| | `VERCEL_API_BASE`, `DEPLOY_CONCURRENCY` (8), `VERCEL_POLL_INTERVAL_MS` (3000), `VERCEL_DEPLOY_TIMEOUT_MIN` (45) | from step 12 |
| `backend/.env` | `VERCEL_SERVICE_URL` (`http://127.0.0.1:3002`), `INTERNAL_SERVICE_TOKEN`, `INTERNAL_CALLBACK_SECRET` | the main side of the same two secrets |

### A8. Revised execution order

1. Step 0 (spike), with the script at `vercel_integration/scripts/vercel-spike.ts`.
2. Scaffold the service: A1, A2, `config.ts`, `/health`, internal auth, Prisma schema `vercel` +
   first migration.
3. Steps 2, 3, 5 and 6 inside the service (provider core, HTTP client, `VercelProvider`, upload),
   with their unit tests.
4. Step 4 inside the service (credentials), plus the A4 credential routes.
5. Step 7 inside the service (queue, runner, resume on boot), plus A5 callbacks and the A4
   deployment routes.
6. The main-backend seam, A6 items 1–7.
7. Step 10 (frontend), step 11 (stretch), step 12 (docs: both READMEs, both `.env.example`
   files, API contract, `PLAN.md`).

### A9. Extra verification for the split

- **Service tests:** `cd backend/vercel_integration && npm run typecheck && npm test`.
  - `internal-auth.test.ts`: a missing or wrong token gets 401.
  - `callback-client.test.ts`: the HMAC is correct, events go in order, failed deliveries are
    retried and persisted.
  - The route tests use Fastify's `inject()`.
- **Main-backend tests:**
  - `provider-events/route.test.ts`: bad signature → 401; duplicate or old `seq` is ignored;
    log lines reach the writer; `terminal` closes it.
  - `vercel-service.client.test.ts`: errors pass through; unreachable → clear message.
- **Manual, in addition to Verification §4:**
  - Stop the microservice, then open Settings and the configure page → "Vercel integration
    service is not running" with no crash.
  - Restart **the microservice** mid-build → it resumes polling and the build page keeps
    streaming.
  - Restart **the main backend** mid-build → the callbacks queued in the meantime are delivered,
    and the row finishes correctly.
  - `curl` the microservice without `x-internal-token` → 401.
  - Confirm the token is not in the main backend's database at all, and is sealed in
    `vercel."VercelCredential"`.
