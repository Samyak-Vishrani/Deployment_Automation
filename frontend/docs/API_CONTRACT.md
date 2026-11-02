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
                                      // its provider can deploy today (Vercel, Render; Neon in Phase 8)
  checks: Array<{
    id: string;                       // "components" | "root-dir:<id>" | "env:<id>" | "credential:<provider>"
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
- each `<rootDir>/.env.example` key has a value in the project's env vars (`DATABASE_URL` counts as
  supplied when a database component is configured)
- each provider has a connected account. Vercel and Render: `pass` when connected, otherwise `fail`
  (not connected, token/key rejected, or the integration service is not running). Neon stays
  `pending` until Phase 8.
- Render backends only: `runtime:<id>` (a framework Render can run: express, nestjs, fastapi,
  docker…) and `start-cmd:<id>` (a start command; not needed for `docker`)

Errors: `400 bad_request` for validation (unknown field, `..` in a path, wrong provider for the kind,
two components of one kind in one folder, more than one database); `404 not_found` for a project or
component that does not exist or belongs to another user; `409 conflict` when a `PATCH` moves a
component onto a folder another component of the same kind already uses.

## Providers: Vercel and Render deploys

Live on the backend from Phase 6 (Vercel) and Phase 7 (Render). Each provider's work runs in its
own service (`backend/vercel_integration`, `backend/render_integration`), which the backend proxies
to. The browser only ever talks to the backend, with the session cookie. `:provider` is `vercel` or
`render`.

| Method | Route | Response |
| --- | --- | --- |
| `GET` | `/api/providers/credentials` | `ProviderCredential[]`: Vercel, Render, then Neon as `unavailable` |
| `GET` | `/api/providers/:provider/credential` | `ProviderCredential` |
| `PUT` | `/api/providers/:provider/credential` | body `{ "token": "…" }` (Vercel token or Render API key). Validated with the provider, stored encrypted; returns `ProviderCredential` |
| `PATCH` | `/api/providers/vercel/credential` | body `{ "teamId": "team_…" \| null }`. The team new projects go to |
| `PATCH` | `/api/providers/render/credential` | body `{ "ownerId"?, "region"?, "plan"? }`. Workspace (locked once a service exists), and region/plan for new services |
| `DELETE` | `/api/providers/:provider/credential` | `{ "deleted": boolean }`. What exists on the provider is kept |
| `POST` | `/api/projects/:projectId/components/:componentId/deploy` | `202` `DeployRun`, queued at the branch head |
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
  scopeLocked?: boolean;              // a Vercel project / Render service exists, so team/workspace is fixed
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
};
```

A Vercel deploy reuses the existing run plumbing:
- `status` keeps its five values (`queued → running → success | failed | cancelled`), while
  `providerStatus` carries Vercel's finer progress.
- `/api/events` emits `{ kind: "deployment" }` on every change.
- `/api/deployments/:id/logs/stream` streams Vercel's build output.
- `POST /api/deployments/:id/cancel` also cancels on Vercel.
- When the deploy goes live, the component's `status` becomes `live` and its `url` is the
  production `*.vercel.app` address.

A push that changes files under a component's `rootDir` redeploys it, but only once the component
has been deployed at least once. Vercel's own deploy-on-push is switched off for projects we create.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `bad_request` | unknown provider, Render/Neon before their phase, a local-Docker component, a project without a repo or branch |
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
