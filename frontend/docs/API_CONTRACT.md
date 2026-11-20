# OrbitOps API contract

The frontend currently uses `MockPlatformProvider`. The future NestJS API should preserve the same response shapes so the UI can switch to `HttpPlatformProvider` without changing page components.

## Session

All protected requests use a backend-issued JWT in an HttpOnly cookie. The frontend sends same-origin requests with credentials and never reads the token.

| Method | Route | Response |
| --- | --- | --- |
| `POST` | `/auth/login` | `{ "user": User }` and `Set-Cookie` |
| `GET` | `/auth/me` | `{ "user": User }` |
| `POST` | `/auth/logout` | `204` or `{ "ok": true }` |

## Projects and delivery

| Method | Route | Response |
| --- | --- | --- |
| `GET` | `/projects` | `Project[]` |
| `POST` | `/projects` | `Project` |
| `GET` | `/projects/:projectId` | `Project` |
| `GET` | `/projects/:projectId/pipeline-runs` | `PipelineRun[]` |
| `POST` | `/projects/:projectId/pipeline-runs` | `PipelineRun` |
| `GET` | `/pipeline-runs/:runId` | `PipelineRun` |
| `POST` | `/pipeline-runs/:runId/cancel` | `PipelineRun` |
| `GET` | `/pipeline-runs/:runId/logs` | `LogEntry[]` |
| `GET` | `/projects/:projectId/deployments` | `Deployment[]` |
| `GET` | `/deployments/:deploymentId/logs` | `LogEntry[]` |
| `POST` | `/deployments/:deploymentId/redeploy` | `Deployment` |
| `GET` | `/projects/:projectId/health` | `HealthCheck[]` |
| `GET` | `/projects/:projectId/ai-insights` | `AiInsight[]` |

Pipeline creation accepts `{ "simulation": "success" | "failure" }` only in the local demo. The live API should instead accept the selected branch, commit, or workflow inputs and return an immutable run identifier.

Deployment versions must use a commit SHA or image digest. Do not use `latest` as the only deployment identifier.

## Repository analysis

Live on the backend today (the `/deploy` pages use it; routes are under `/api`).

| Method | Route | Response |
| --- | --- | --- |
| `POST` | `/api/projects/:projectId/analyze` | `ProjectAnalysis` |
| `GET` | `/api/projects/:projectId/analysis` | `ProjectAnalysis` |

`POST` analyses the project's branch at its current commit. If that commit already has a snapshot it
is returned with `"reused": true`; `?force=1` runs the analysis again regardless. `GET` returns the
latest successful snapshot, or the same shape with `"analysisId": null` and empty `components` when
the project has never been analysed.

```jsonc
{
  "projectId": "cm…",
  "projectName": "shop",
  "repository": "owner/shop",
  "analysisId": "cm…",          // null until an analysis has succeeded
  "branch": "main",
  "commitSha": "714ae009…",     // every file was read at this commit
  "source": "tree",             // "tarball" when the repo was too large for the tree API
  "analyzedAt": "2026-09-30T08:35:16.968Z",   // "" when never analysed
  "reused": false,
  "warnings": [
    { "code": "ignored_paths", "message": "3 config file(s) under … folders were skipped." },
    { "code": "file_unreadable", "path": "api/package.json", "message": "Could not read …" }
  ],
  "database": {                  // null when never analysed
    "detected": true,
    "engine": "postgres",        // postgres | mysql | mongodb | sqlite | unknown
    "evidence": ["backend/prisma/schema.prisma: provider", "backend/package.json: pg"],
    "suggestNeon": true          // Postgres or unknown SQL; never MongoDB
  },
  "components": [
    {
      "id": "cm…",
      "path": "frontend",        // "." is the repository root
      "role": "frontend",        // frontend | backend | unknown
      "type": "web",             // legacy: web | api | worker
      "framework": "nextjs",
      "language": "typescript",
      "packageManager": "pnpm",
      "detectedVersion": "14.0.0",
      "runtimeVersion": ">=20",  // as the repo wrote it, or null
      "installCmd": "pnpm install",
      "buildCmd": "pnpm run build",
      "startCmd": "pnpm start",  // null for a static build
      "outputDir": ".next",      // null for a backend
      "confidence": 0.98,        // 0..1
      "evidence": ["frontend/package.json: next@^14.0.0", "frontend/next.config.mjs"],
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

Warning codes: `ignored_paths`, `outside_workspace`, `too_many_files`, `file_unreadable`,
`file_too_large`, `invalid_manifest`, `tree_truncated`. None of them fails the analysis.

Errors use the shared `{ "error": code, "message": text }` shape:

| Status | `error` | When |
| --- | --- | --- |
| `401` | `unauthorized` | No session |
| `404` | `project_not_found` | No such project, or it belongs to another user |
| `400` | `github_not_connected` | The project has no repository or branch |
| `404` | `repo_not_found` | The repository or branch is gone, or the GitHub App cannot see it |
| `502` | `github_api_error` | GitHub answered with an error |
| `500` | `analysis_failed` | The detection engine itself failed |

## Deployment configuration

Live on the backend (under `/api`). A **component** is one deployable part of a project as the user
confirmed it. It is stored apart from the analysis, so re-analysing never changes it. The MVP fixes the
provider per kind: `frontend` → `vercel`, `backend` → `render`, `database` → `neon`.

| Method | Route | Response |
| --- | --- | --- |
| `GET` | `/api/projects/:projectId/components` | `DeployComponent[]` (frontends first) |
| `GET` | `/api/projects/:projectId/components/proposal` | `ComponentProposal` (runs the analysis first if there is none; saves nothing) |
| `PUT` | `/api/projects/:projectId/components` | `DeployComponent[]`, the saved set |
| `PATCH` | `/api/projects/:projectId/components/:componentId` | `DeployComponent` |
| `DELETE` | `/api/projects/:projectId/components/:componentId` | `{ "deleted": true, "id": "…" }` |
| `GET` | `/api/projects/:projectId/preflight` | `PreflightResult` |

```ts
type ComponentFields = {
  kind: "frontend" | "backend" | "database";
  name: string;                       // ≤ 100 chars
  rootDir: string;                    // relative, no "..", no leading "/"; "." is the root
  framework: string | null;
  installCmd: string | null;          // commands: one line, ≤ 500 chars; null on a database
  buildCmd: string | null;
  startCmd: string | null;
  outputDir: string | null;
  nodeVersion: string | null;
  healthCheckPath: string | null;     // backends only: "/health"-style path (Phase 7); null otherwise
  provider: "vercel" | "render" | "neon" | "local_docker";   // optional on PUT: defaults from kind
  analysisComponentId: string | null; // the analysis row it was proposed from
};

type DeployComponent = ComponentFields & {
  id: string;
  projectId: string;
  providerResourceId: string | null;  // set by the provider phases
  url: string | null;
  status: "draft" | "configured" | "deploying" | "live" | "failed";
  createdAt: string;
  updatedAt: string;
};

type ComponentProposal = {
  analysisId: string | null;
  branch: string | null;
  commitSha: string | null;
  analyzedAt: string;
  components: Array<Omit<ComponentFields, "kind" | "provider"> & {
    kind: ComponentFields["kind"] | null;        // null when the analysis could not tell
    provider: ComponentFields["provider"] | null;
    evidence: string[];
    confidence: number | null;
  }>;
};

type PreflightResult = {
  ok: boolean;                        // every check is "pass" (Phase 8's "Deploy all")
  deployable: Record<string, boolean>; // per component id: its checks + its provider account pass, and
                                      // its provider can deploy (Vercel, Render, Neon: a database "deploys"
                                      // by being provisioned)
  checks: Array<{
    id: string;                       // "components" | "root-dir:<id>" | "env:<id>" | "credential:<provider>"
                                      // | "runtime:<id>" | "start-cmd:<id>" | "engine:<id>" | "migrations:<id>"
    componentId?: string;
    status: "pass" | "fail" | "pending";
    message: string;                  // names env vars, never their values
  }>;
};
```

`PUT` takes `{ "components": ComponentFields[] }`, the complete set. Rows are matched on
`(kind, rootDir)`. A match is updated in place, so its `providerResourceId`, `url` and status survive;
a `draft` becomes `configured`. New rows are created as `configured`, and rows left out are deleted.
`PATCH` takes any subset of the fields except `kind` and `analysisComponentId`.

Pre-flight checks:

- at least one component is configured
- each `rootDir` is a folder on the branch
- each `<rootDir>/.env.example` key has a value in the component's env vars (Phase 9: its own, plus
  shared for a backend). Keys OrbitOps sets at deploy time count as supplied:
  - `DATABASE_URL` / `DATABASE_URL_UNPOOLED` on a Render backend when a Neon database is configured;
  - the API URL key (e.g. `NEXT_PUBLIC_API_URL`) on a Vercel frontend with exactly one backend.
- `env-reserved:<id>`, only when it fails: a stored key that the provider sets itself (`RENDER_*`,
  `VERCEL_*`…)
- each provider has a connected account: `pass` when connected, otherwise `fail` (not connected,
  token or key rejected, or the integration service is not running). This applies to Vercel,
  Render and Neon.
- Render backends only: `runtime:<id>` (a framework Render can run: express, nestjs, fastapi,
  docker…) and `start-cmd:<id>` (a start command; not needed for `docker`)
- Neon databases only (Phase 8):
  - `engine:<id>`: the database is Postgres; an empty engine counts as Postgres, `mysql` fails;
  - `migrations:<id>`: always `pass`. It carries the advice that migrations are the user's job,
    and names `DATABASE_URL` / `DATABASE_URL_UNPOOLED`.

Errors: `400 bad_request` for validation (unknown field, `..` in a path, wrong provider for the kind,
two components of one kind in one folder, more than one database); `404 not_found` for a project or
component that does not exist or belongs to another user; `409 conflict` when a `PATCH` moves a
component onto a folder another component of the same kind already uses.

## Providers: Vercel, Render and Neon

Live on the backend from Phase 6 (Vercel), Phase 7 (Render) and Phase 8 (Neon). Each provider's work
runs in its own service, which the backend proxies to:
- `backend/vercel_integration`;
- `backend/render_integration`;
- `backend/neondb_integration`.

The browser only ever talks to the backend, with the session cookie. `:provider` is `vercel`,
`render` or `neon`.

| Method | Route | Response |
| --- | --- | --- |
| `GET` | `/api/providers/credentials` | `ProviderCredential[]`: Vercel, Render, Neon (`unavailable` when a service is down) |
| `GET` | `/api/providers/:provider/credential` | `ProviderCredential` |
| `PUT` | `/api/providers/:provider/credential` | body `{ "token": "…" }` (Vercel token, Render or Neon API key). Validated with the provider, stored encrypted; returns `ProviderCredential` |
| `PATCH` | `/api/providers/vercel/credential` | body `{ "teamId": "team_…" \| null }`. The team new projects go to |
| `PATCH` | `/api/providers/render/credential` | body `{ "ownerId"?, "region"?, "plan"? }`. Workspace (locked once a service exists), and region/plan for new services |
| `PATCH` | `/api/providers/neon/credential` | body `{ "orgId"?: string \| null, "regionId"?, "pgVersion"? }`. Organization (locked once a project exists), and region/version for new databases |
| `DELETE` | `/api/providers/:provider/credential` | `{ "deleted": boolean }`. What exists on the provider is kept |
| `POST` | `/api/projects/:projectId/components/:componentId/deploy` | `202` `DeployRun`, queued at the branch head. For a Neon database: the provisioning run (`provider: "neon"`, `status: "running"`) |
| `GET` | `/api/projects/:projectId/components/:componentId/deployments` | `DeployRun[]`, the last 20 |

```ts
type ProviderCredential = {
  provider: "vercel" | "render" | "neon";
  state: "connected" | "invalid" | "missing" | "unavailable"; // unavailable: service down / later phase
  accountName?: string | null;
  teamId?: string | null;             // null = personal scope
  teamSlug?: string | null;
  teams?: Array<{ id: string; slug: string; name: string }>;
  ownerId?: string | null;            // Render: the workspace new services go to
  ownerName?: string | null;
  owners?: Array<{ id: string; name: string; type: string }>;
  region?: string | null;             // Render: oregon | ohio | virginia | frankfurt | singapore
  plan?: string | null;               // Render: free | starter | standard
  orgId?: string | null;              // Neon: the organization new projects go to (null = the key's default)
  orgName?: string | null;
  orgs?: Array<{ id: string; name: string }>;
  regionId?: string | null;           // Neon: aws-us-west-2 (default), aws-eu-central-1, …
  pgVersion?: number | null;          // Neon: 15 | 16 | 17
  scopeLocked?: boolean;              // a Vercel project / Render service / Neon project exists, so the scope is fixed
  lastValidatedAt?: string | null;
  message?: string;                   // why it is unavailable
};

// DeployRun (from /api/deployments/:id and the history lists) gains:
type DeployRunProviderFields = {
  componentId: string | null;         // null for the project-wide Docker builds
  provider: "vercel" | "render" | "neon" | "local_docker";
  providerStatus: "queued" | "deploying" | "building" | "live" | "failed" | "cancelled" | null;
  providerDeploymentId: string | null; // Vercel's dpl_…
  sourceMode: "git" | "upload" | null; // git: Vercel read GitHub itself; upload: we sent the files
  url: string | null;                 // this deployment's own *.vercel.app URL
  inspectorUrl: string | null;        // the Vercel dashboard page
  releaseId?: string | null;          // the Deploy all it belongs to (Phase 8)
};
```

A Vercel deploy reuses the existing run plumbing:
- `status` keeps its five values (`queued → running → success | failed | cancelled`), while
  `providerStatus` carries Vercel's finer progress.
- `/api/events` emits `{ kind: "deployment" }` on every change.
- `/api/deployments/:id/logs/stream` streams Vercel's build output (see "Logs" below).
- `POST /api/deployments/:id/cancel` also cancels on Vercel.
- When the deploy goes live, the component's `status` becomes `live` and its `url` is the
  production `*.vercel.app` address.

A push that changes files under a component's `rootDir` redeploys it, but only once the component
has been deployed at least once. Vercel's own deploy-on-push is switched off for projects we create.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `bad_request` | unknown provider, a local-Docker component, a project without a repo or branch |
| 404 | `not_found` | project or component missing, or another user's |
| 412 | `vercel_not_connected` | no Vercel token saved |
| 412 | `vercel_token_invalid` | Vercel rejected the saved token; reconnect in Settings |
| 403 | `vercel_forbidden` | the token cannot act in the selected team |
| 409 | `conflict` | changing team after a Vercel project exists; saving a token for a different Vercel account once projects exist |
| 429 | `vercel_limit` / `vercel_rate_limited` | Vercel plan limit or rate limit |
| 502 | `vercel_unavailable` / `vercel_error` | Vercel unreachable or returned an error |
| 503 | `vercel_service_unavailable` | the Vercel integration service is not running, or the shared token differs |
| 412 | `render_not_connected` / `render_key_invalid` | no Render API key saved / Render rejected it |
| 400 | `render_repo_access` | Render cannot read the repository: connect Render to GitHub with access to it |
| 400 | `render_missing_start` / `render_unknown_runtime` | the backend has no start command / no framework Render can run |
| 429 | `render_billing` / `render_rate_limited` | the plan needs billing details on Render / Render rate limit |
| 503 | `render_service_unavailable` | the Render integration service is not running, or `RENDER_SERVICE_TOKEN` differs |

A Render deploy also sends the project's env vars to Render (never returned, never logged) and
reports `sourceMode: "git"`, `inspectorUrl` = the deploy on Render's dashboard, and, once live,
the component's `url` = its `https://*.onrender.com` address.

**Neon (Phase 8).** Deploying a database component provisions it:
- a run with `provider: "neon"` and its own log;
- `status` goes `running → success | failed` in seconds;
- once ready, the component is `live`, and its `url` and the run's `inspectorUrl` are the Neon
  console page.

A Render backend in a project with a Neon database is then deployed with `DATABASE_URL` (pooled)
and `DATABASE_URL_UNPOOLED` (direct):
- they are fetched fresh, and override the project's own values;
- they are never returned, stored or logged;
- an unprovisioned database is provisioned first.

A Vercel frontend in a project with exactly one backend that has a URL is deployed with that URL
under its framework's public key (`NEXT_PUBLIC_API_URL` for Next.js).

| Status | `error` | When |
| --- | --- | --- |
| 412 | `neon_not_connected` / `neon_key_invalid` | no Neon API key saved / Neon rejected it |
| 412 | `neon_org_required` | Neon needs an organization: choose one in Settings |
| 409 | `neon_project_limit` | the Neon plan's project limit is reached |
| 502 | `neon_provision_failed` | Neon could not set the database up (also on a backend deploy whose database failed) |
| 504 | `neon_provision_timeout` | still setting up after 60 s; deploying again carries on |
| 503 | `neon_service_unavailable` | the Neon DB integration service is not running, or `NEON_SERVICE_TOKEN` differs |

## Releases: Deploy all (Phase 8)

| Method | Route | Response |
| --- | --- | --- |
| `POST` | `/api/projects/:projectId/releases` | `202` `Release`. Runs database → backend → frontend at the branch head |
| `GET` | `/api/projects/:projectId/releases?take=` | `Release[]`, newest first (default 10, max 50) |
| `GET` | `/api/releases/:releaseId` | `Release` |
| `POST` | `/api/releases/:releaseId/cancel` | `Release`. Running Vercel/Render deploys are cancelled; later steps never start |

```ts
type Release = {
  id: string;
  projectId: string;
  number: number;                     // per project: #1, #2…
  status: "running" | "success" | "failed" | "cancelled";
  stage: number;                      // 0 database, 1 backend, 2 frontend, 3 done
  trigger: string;
  branch: string;
  commitSha: string;                  // one commit for every step
  commitMessage: string | null;
  errorMessage: string | null;        // "Backend api failed, so the frontend was not deployed. …"
  createdAt: string;
  finishedAt: string | null;
  steps: Array<{
    stage: number;
    kind: "database" | "backend" | "frontend";
    componentId: string;
    componentName: string;
    provider: "neon" | "render" | "vercel";
    deployment: {                     // null until the step starts
      id: string; status: DeploymentStatus; providerStatus: string | null; url: string | null;
      errorMessage: string | null; queuedAt: string; finishedAt: string | null;
    } | null;
  }>;
};
```

`/api/events` also emits `{ kind: "release", projectId, releaseId, status, stage }` whenever a
release moves on.

| Status | `error` | When |
| --- | --- | --- |
| 409 | `release_in_progress` | a release of this project is still running |
| 412 | `preflight_failed` | pre-flight has not passed; nothing was deployed (the message lists the failing checks) |
| 400 | `bad_request` | no component deploys to Vercel, Render or Neon |
| 404 | `not_found` | project or release missing, or another user's |

## Environment variables (Phase 9)

Values are sealed at rest and **never** returned, except by the reveal routes for non-secret
variables. A PUT replaces the scope's whole set: keys left out are deleted, and a `value` left out
keeps the stored one. Changes apply on the component's next deploy.

| Method | Route | Response |
| --- | --- | --- |
| `GET` | `/api/projects/:projectId/env` | `EnvironmentView` |
| `PUT` | `/api/projects/:projectId/env` | body `{ vars: EnvPutEntry[] }`: the **shared** set (every backend + local Docker) → `EnvironmentView` |
| `GET` | `/api/projects/:projectId/env/:key` | `{ key, value }` of a non-secret shared variable; `cache-control: no-store` |
| `PUT` | `/api/projects/:projectId/components/:componentId/env` | body `{ vars: EnvPutEntry[] }`: the component's own set → `EnvironmentView` |
| `GET` | `/api/projects/:projectId/components/:componentId/env/:key` | `{ key, value }` of a non-secret component variable; `no-store` |
| `GET` | `/api/projects/:projectId/components/:componentId/env/suggestions` | `{ path, found, suggestions: EnvSuggestion[] }` from `<rootDir>/.env.example` at the branch head |

```ts
type EnvPutEntry = { key: string; value?: string; isSecret?: boolean }; // isSecret defaults to true
type EnvVarView = { key: string; isSecret: boolean; updatedAt: string };  // never a value
type EnvironmentView = {
  projectId: string;
  shared: EnvVarView[];
  components: Array<{
    componentId: string; name: string; kind: "frontend" | "backend" | "database"; provider: ProviderId;
    vars: EnvVarView[];
    system: Array<{ key: string; source: "neon" | "backend"; from: string; userWins: boolean }>;
    receivesShared: boolean;          // backends
    revision: number;
    pendingRedeploy: boolean;         // saved changes newer than the last successful deploy
  }>;
};
type EnvSuggestion = {
  key: string;
  example: string | null;             // only for keys that do not look secret
  looksSecret: boolean; alreadySet: boolean; providedBySystem: boolean;
};
```

| Status | `error` | When |
| --- | --- | --- |
| 400 | `bad_request` | an invalid, duplicate or reserved key; a value over 32 KB; over 100 variables; over 64 KB on a Vercel frontend; a public-prefix key (`NEXT_PUBLIC_*`…) marked secret on a frontend; a database component |
| 400 | `env_value_required` | a new key without a value, or a secret turned non-secret without its value |
| 403 | `env_secret` | reveal of a secret |
| 404 | `not_found` | project, component or key missing, or another user's |
| 409 | `conflict` | the same set was saved concurrently |

A Vercel deploy whose values were lost before it reached Vercel (the queue outlived the in-memory
vault) fails with `vercel_interrupted`: "deploy again". `Project.envKeys` lists the shared keys.

## Logs (Phase 12)

Served from `backend/logs` through the backend, which checks ownership. Every route is about
**one** deployment or **one** component: logs of different components or providers are never
combined.

```ts
type LogEntry = {
  seq: number;                          // per deployment; the SSE id
  at: number;                           // ms since epoch (the provider's time when it gave one)
  source: "orbitops" | "vercel" | "render" | "neon" | "docker";
  phase: "setup" | "build" | "deploy" | "runtime";
  stream: "info" | "stdout" | "stderr";
  text: string;                         // already redacted
};
type RuntimeLogEntry = {
  id: string; at: number; source: LogSource; stream: "stdout" | "stderr"; level?: string; text: string;
  request?: { method?: string; path?: string; status?: number };
};
type LogsIndex = {
  projectId: string;
  components: Array<{
    componentId: string; name: string; kind: ComponentKind; provider: ProviderId;
    runtime: "available" | "not_deployed" | "unsupported"; runtimeNote: string | null;
    deployments: Array<{ id; status; trigger; queuedAt; finishedAt; commitSha; commitMessage; releaseNumber: number | null }>;
  }>;
  docker: { deployments: [...]; runtime: "available" | "not_running" } | null;
};
```

| Method | Route | Response |
| --- | --- | --- |
| `GET` | `/api/deployments/:id/logs` | `{ id, log }`: the whole log as text, `[12:03:04] [render] text` per line |
| `GET` | `/api/deployments/:id/logs?format=entries&afterSeq=&limit=` | `{ id, componentId, provider, entries: LogEntry[], nextSeq, complete, truncated }` (limit ≤ 5000) |
| `GET` | `/api/deployments/:id/logs/download` | `text/plain` attachment `<project>-<component>-<provider>-<sha7>-<id>.log` |
| `GET` | `/api/deployments/:id/logs/stream` | SSE: `event: entry` with `id: <seq>` and `data: LogEntry`, then `done` (`{ status }`). Honours `Last-Event-ID` / `?afterSeq=` to resume |
| `GET` | `/api/projects/:projectId/logs` | `LogsIndex` |
| `GET` | `/api/projects/:projectId/components/:componentId/runtime-logs/stream?since=5m\|15m\|1h&requests=0\|1` | SSE: `session` (`{ sessionId, source }`), then `entry` (`RuntimeLogEntry`), `notice` (`{ text }`), `end` (`{ reason, message }`); not stored |
| `GET` | `/api/projects/:projectId/runtime-logs/stream?since=` | the same, for the project's local Docker container |
| `POST` | `/api/projects/:projectId/runtime-logs/:sessionId/ping` | `{ ok: true }`. Send every 60 s while the page is visible, or the stream ends `idle` after 15 minutes |

A runtime stream ends with `end`:

| `reason` | Meaning |
| --- | --- |
| `idle` | no ping for 15 minutes |
| `max_duration` | open for 60 minutes |
| `upstream_closed` | the provider closed the stream |
| `error` | the provider kept failing; the message says why |

Resuming opens a new stream. Lines already shown can come again in the backfill: skip them by `id`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `runtime_logs_unsupported` | a Neon database: Neon has no runtime log API |
| 404 | `not_deployed` / `not_running` | the component is not live on its provider yet / the Docker container is not running |
| 409 | `runtime_logs_busy` | 3 runtime streams of this user are already open |
| 412 | `render_key_invalid`, `vercel_token_invalid`, … | the provider rejected the saved credential |
| 503 | `logs_service_unavailable` | `backend/logs` is not running, or `LOGS_SERVICE_TOKEN` differs |
| 503 | `log_proxy_disabled` | `LOGS_PROXY_TOKEN` is not set in the Vercel or Render service |
| 404 | `not_found` | another user's deployment, project, component or stream |

## Repositories

Live on the backend (under `/api`). Read with the signed-in user's own GitHub token, so a user only
ever sees installations and repositories GitHub lets them see.

| Method | Route | Response |
| --- | --- | --- |
| `GET` | `/repositories` | `RepositoryList` |
| `GET` | `/repositories/:owner/:repo/branches` | `{ defaultBranch, branches: [{ name, protected }] }` |

```ts
type RepositoryList = {
  installUrl: string;                 // install the App on more repositories
  installations: Array<{
    id: string;
    account: string;                  // user or organisation login
    accountType: string;              // "User" | "Organization"
    repositorySelection: "all" | "selected";
    manageUrl: string;                // GitHub's settings page for the installation
  }>;
  repositories: Array<{
    id: number;                       // GitHub's numeric repo id
    fullName: string;
    owner: string;
    name: string;
    private: boolean;
    defaultBranch: string;
    installationId: string;
    pushedAt: string | null;
    projectId: string | null;         // set when this user already connected it
  }>;
  truncated: boolean;                 // an installation has more than 500 repositories
};
```

`POST /projects` takes the same `repoUrl` as before, and now also checks that the signed-in user can
read the repository; one they cannot see answers `404` with the "not installed" message, so a
private repository's existence is never confirmed.

| Status | `error` | When |
| --- | --- | --- |
| `401` | `unauthorized` | No session |
| `409` | `github_reconnect_required` | No usable GitHub token: never stored, expired, or revoked. Send the user through `/api/auth/github?next=…` |
| `400` | `bad_request` | Invalid owner or repository name |
| `404` | `not_found` | Branches requested for a repository the user cannot see |
| `502` | `github_error` | GitHub answered with an error |

`GET /auth/me` adds `user.githubConnected: boolean` — a usable token is stored.

## Integration notes

- Start with manual pipeline triggers and status polling.
- Add GitHub push and `workflow_run` webhooks after the manual path works.
- Keep repository credentials and registry tokens on the backend.
- Return normalized stage states so the frontend does not need to understand GitHub-specific job names.
- Return health checks separately from raw metrics so the first UI can remain stable while Prometheus, Loki, or OpenTelemetry are added.
