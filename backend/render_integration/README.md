# Render integration service

Phase 7 of `PLAN.md`: deploys a project's **backend component** to the user's own Render account.

This is a separate service, next to the main backend (`backend/`, Next.js on :3001) and the Vercel
integration (`backend/vercel_integration`, :3002). It owns everything Render-specific:
- the user's Render API key and the chosen workspace, region and plan;
- the Render web service for each component, and syncing its env vars;
- the deploy itself, status polling, log fetching and the health check.

The main backend authenticates the user, checks they own the project, resolves the commit, reads
the project's env vars, and keeps the `Deployment` rows, log files and the live `/events` feed.

```text
Browser ──► backend :3001 ──x-internal-token (RENDER_SERVICE_TOKEN)──► render_integration :3003 ──► api.render.com/v1
               ▲                                                          │
               └──── POST /api/internal/provider-events ──────────────────┘
                     x-orbitops-provider: render, HMAC with RENDER_CALLBACK_SECRET
```

- **Stack:** Node 22, TypeScript run with `tsx`, Fastify, Prisma, Vitest.
- **Data:** the same Postgres as the backend, in its own schema (`?schema=render`). There are no
  foreign keys into anyone else's tables, and nobody else reads these.
- **No imports** from `backend/lib` or `backend/vercel_integration`. The shared plumbing is copied
  in, and each copy's first lines say where it came from:
  - the internal-token check, secret-box, redact;
  - the retrying fetch and provider errors;
  - the callback outbox, the deploy queue, and the fake DB used by tests.
- **Listens on** `127.0.0.1` only. Every route except `/health` requires `x-internal-token`.
- **Its own secrets.** `RENDER_SERVICE_TOKEN`, `RENDER_CALLBACK_SECRET` and `ENCRYPTION_KEY` are
  shared with nothing but the backend. The backend checks that a Render-signed event only touches
  Render deployments.

## Run it

```bash
cp .env.example .env        # fill in the secrets (below)
npm install
npx prisma migrate deploy   # creates the "render" schema and its tables
npm run dev                 # tsx watch, :3003
```

| Variable | What |
| --- | --- |
| `RENDER_SERVICE_TOKEN` | the same value as in `backend/.env`; at least 32 characters |
| `RENDER_CALLBACK_SECRET` | the same value as in `backend/.env`; at least 32 characters |
| `ENCRYPTION_KEY` | 32 bytes, base64; seals Render API keys. A key of its own |
| `DATABASE_URL` | the backend's Postgres URL with `?schema=render` |

The service fails at startup with a list of whatever is missing.

**On Render's side:** connect Render to GitHub (dashboard.render.com → Account Settings → Git)
with access to the repositories you deploy. Render builds from GitHub itself; there is no file
upload, so a repo Render cannot read fails with a clear `render_repo_access` error.

## How a deploy runs

1. **The backend sends `POST /deployments`.** The body holds the component's settings (framework,
   install/build/start commands, Node version, health check path), the repo and branch, the exact
   commit SHA, and the project's env vars.
   - The service stores the request **without** the env values. They are held in memory for the
     run only (`deployments/env-vault.ts`), and it returns 202.
2. **The web service is created or updated** (`src/render/render.provider.ts`):
   - **First deploy:** `POST /v1/services` creates a `web_service`.
     - The runtime comes from the framework (`runtime-map.ts`). Render's single build command is
       install `&&` build.
     - The workspace, region and plan come from Settings.
     - `autoDeployTrigger: "off"`, so a push never deploys on Render's own.
     - The env vars are included, plus `NODE_VERSION` from the component.
   - **Later deploys:**
     - PATCH only when the settings hash changed (commands, root, branch, health path).
     - Env vars are upserted key by key only when their hash changed.
     - Keys this service set before but that are gone are deleted. Variables added by hand on
       Render are never touched.
     - Runtime, region and plan are fixed by Render after creation.
   - The service id is stored before deploying, so a crash cannot create a second one.
3. **The exact commit is deployed.** Creating a service makes Render deploy the branch head on its
   own:
   - if that deploy is building our SHA, it is adopted;
   - otherwise it is cancelled, then `POST /services/:id/deploys { commitId }`.
4. **The runner polls** the deploy every 3 s, backing off to 10 s, and reads build and app logs
   (`GET /v1/logs`) until the deploy is live, failed or cancelled. It times out after 45 min.
   - A failure message names the stage that failed and, when the log shows the usual causes, a
     hint (`error-hints.ts`). Examples: no open port (listen on `process.env.PORT`), no repo
     access, missing module.
5. **Once live**, `GET <url><healthCheckPath>` is tried for up to ~90 s, since free instances
   cold-start. The result is logged and never fails the deploy.
6. **Every step is reported to the backend** through the outbox: status, the service id, the
   deploy id with its dashboard link, log lines (redacted: API key and every env value), and the
   terminal state with the `*.onrender.com` URL.
   - Batches are ordered, persisted before sending, and retried; the backend ignores repeats.

**Restarts.** A deploy Render already has is resumed by polling again. One interrupted before it
reached Render is failed with "deploy again", because its env vars were only ever in memory.
Undelivered event batches are re-sent on start.

**Cancel.** A user cancel aborts the run and cancels the deploy on Render. A shutdown does not:
Render keeps building, and the next start resumes polling.

## Status mapping

| Render `deploy.status` | Normalised | Main backend `Deployment.status` |
| --- | --- | --- |
| `created`, `queued` | `queued` | `running` |
| `build_in_progress`, `pre_deploy_in_progress` | `building` | `running` |
| `update_in_progress` | `deploying` | `running` |
| `live`, `deactivated` | `live` | `success` |
| `build_failed`, `update_failed`, `pre_deploy_failed` | `failed` | `failed` |
| `canceled` | `cancelled` | `cancelled` |

## Internal API

All routes except `/health` need `x-internal-token: <RENDER_SERVICE_TOKEN>`.

| Method & path | Purpose |
| --- | --- |
| `GET /health` | liveness + database check |
| `GET /users/:userId/credential` | `{ state, accountName, ownerId, ownerName, owners, region, plan, scopeLocked }`; never the key |
| `PUT /users/:userId/credential` | `{ apiKey }`: validated with `GET /v1/owners`, then sealed and stored |
| `PATCH /users/:userId/credential` | `{ ownerId?, region?, plan? }`; the workspace is locked once a service exists |
| `DELETE /users/:userId/credential` | forget the key; services on Render are kept |
| `POST /deployments` | start a deploy, returns 202 (idempotent on `deploymentId`) |
| `GET /deployments/:deploymentId` | current state |
| `GET /deployments?state=active` | unfinished deploys, used by the backend's restart reconciliation |
| `POST /deployments/:deploymentId/cancel` | cancel here and on Render |
| `PUT /components/:componentId/env?userId=` | Phase 9 hook: upsert env vars on the service |
| `POST /components/:componentId/rollback?userId=` | Phase 11 hook: `{ renderDeployId }` goes live again |
| `DELETE /components/:componentId?userId=` | delete the Render service; not called by the MVP |

## Checking the Render API against your account

Step 0 of `Plans/Plans_Remaining/PLAN_PHASE_7.md` is a spike that records the real answers:

```bash
RENDER_API_KEY=... SPIKE_REPO=owner/repo SPIKE_BRANCH=main SPIKE_ROOT_DIR=backend npm run spike
```

It creates one throwaway free service (`orbitops-spike-*`) and then:
- checks whether creating it returns a `deployId`;
- cancels that initial deploy, then deploys the branch head by commit and polls it;
- reads its logs and tries the env var endpoints;
- deletes the service.

Responses are written, with the key redacted, to `src/render/__fixtures__/`. Use them to confirm
the log labels and the repo-access error text the provider recognises.

## Tests

```bash
npm run typecheck && npm test
```

The tests cover:
- the pure helpers (runtime map, settings + hash, env vars + hash + managed-key diff, names,
  status, logs, failure hints, URL check);
- the HTTP client's error mapping, redaction and `Ratelimit-Reset`;
- the provider against a fake Render API: create, update, recreate, env sync, adopting or
  replacing the initial deploy, log pages, cancel, rollback, the health probe;
- credentials: sealed at rest, workspace lock, region/plan validation;
- the outbox and callback, including the `x-orbitops-provider` header;
- the queue, runner and deployments service: resume, cancel vs shutdown, timeout, env values
  never stored or relayed;
- the Fastify API via `inject()`.
