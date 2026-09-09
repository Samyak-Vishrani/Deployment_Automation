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

## Integration notes

- Start with manual pipeline triggers and status polling.
- Add GitHub push and `workflow_run` webhooks after the manual path works.
- Keep repository credentials and registry tokens on the backend.
- Return normalized stage states so the frontend does not need to understand GitHub-specific job names.
- Return health checks separately from raw metrics so the first UI can remain stable while Prometheus, Loki, or OpenTelemetry are added.
