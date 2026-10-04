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
