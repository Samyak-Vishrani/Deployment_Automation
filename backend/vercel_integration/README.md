# Vercel integration service

Phase 6 of `PLAN.md`: deploys a project's **frontend component** to the user's own Vercel account.

This is a separate service from the main backend (`backend/`, Next.js on :3001). It owns
everything Vercel-specific: the user's Vercel token, the Vercel project for each component, the
deploy itself, status polling and build-log fetching. The main backend authenticates the user,
checks they own the project, and keeps the `Deployment` rows, log files and live `/events` feed.

```text
Browser ──► backend :3001 ──x-internal-token──► vercel_integration :3002 ──► api.vercel.com
               ▲                                       │
               └──── POST /api/internal/provider-events ┘  (HMAC-signed, ordered, retried)
```

- **Stack:** Node 22, TypeScript run with `tsx`, Fastify, Prisma, Vitest.
- **Data:** the same Postgres as the backend, but its own schema (`?schema=vercel`). It has no
  foreign keys into the backend's tables, and neither service reads the other's tables.
- **Imports:** none from `backend/lib`. `secret-box`, `redact` and `fs-utils` are copied in under
  `src/` so the service builds and deploys on its own.
- **Listens on** `127.0.0.1` only. Every route except `/health` requires `x-internal-token`.

## Run it

```bash
cp .env.example .env        # fill in the secrets (below)
npm install
npx prisma migrate deploy   # creates the "vercel" schema and its tables
npm run dev                 # tsx watch, :3002
```

The required secrets, in `.env`:

| Variable | What |
| --- | --- |
| `INTERNAL_SERVICE_TOKEN` | the same value as in `backend/.env`; at least 32 characters |
| `INTERNAL_CALLBACK_SECRET` | the same value as in `backend/.env`; at least 32 characters |
| `ENCRYPTION_KEY` | 32 bytes, base64; seals Vercel tokens. Use a different key from the backend's |
| `DATABASE_URL` | the backend's Postgres URL with `?schema=vercel` |

The service fails at startup with a list of whatever is missing.

## How a deploy runs

1. **The backend sends `POST /deployments`.** The body holds the component's build settings, the
   repo, the exact commit SHA and a short-lived GitHub installation token. The service stores
   everything except the token and returns 202.
2. **The project is created or updated** (`src/vercel/vercel.provider.ts`):
   - On first deploy it creates the Vercel project, linked to the GitHub repo when Vercel's GitHub
     app can see it, then turns off Vercel's own deploy-on-push
     (`gitProviderOptions.createDeployments = "disabled"`). From then on, only we trigger deploys.
   - On later deploys it looks the project up and PATCHes it only when the build settings changed.
   - The project id is stored before deploying, so a crash cannot create a second project.
3. **The deploy is started**, in one of two ways:
   - A linked project deploys from a Git source at the exact SHA.
   - Otherwise the commit is downloaded from GitHub and its files are uploaded. Vercel's
     `missing_files` answer means only new blobs are sent. This is limited to 100 MB / 15k files.
4. **The runner polls** `GET /v13/deployments/:id` and `/v3/deployments/:id/events` every 3 s,
   backing off to 10 s, until the deployment is READY, ERROR or CANCELED. It times out after
   45 min.
5. **Every step is reported to the backend** through the outbox (`src/callbacks/outbox.ts`):
   status, the Vercel project id, the deployment id/URL/dashboard link, log lines and the terminal
   state.
   - Each batch has a sequence number and is persisted before it is sent.
   - Batches are retried for 10 minutes, then left for the next start.
   - The backend ignores any sequence number it has already applied.

**Restarts.** A deploy Vercel already has is resumed: polling picks up where it left off. One
interrupted before it reached Vercel is failed with "deploy again", because its GitHub token was
only ever in memory. Undelivered event batches are re-sent on start.

**Cancel.** A user cancel aborts the run and cancels the deployment on Vercel. A shutdown does
**not**: Vercel keeps building, and the next start resumes polling.

## Internal API

All routes except `/health` need `x-internal-token: <INTERNAL_SERVICE_TOKEN>`.

| Method & path | Purpose |
| --- | --- |
| `GET /health` | liveness + database check |
| `GET /users/:userId/credential` | `{ state: connected\|invalid\|missing, accountName, teamId, teamSlug, teams, scopeLocked }`; never the token |
| `PUT /users/:userId/credential` | `{ token }`: validated with `GET /v2/user` + `/v2/teams`, then sealed and stored |
| `PATCH /users/:userId/credential` | `{ teamId }`: 409 once a Vercel project exists for the user |
| `DELETE /users/:userId/credential` | forget the token (Vercel projects are kept) |
| `POST /deployments` | start a deploy, returns 202 (idempotent on `deploymentId`) |
| `GET /deployments/:deploymentId` | current state |
| `GET /deployments?state=active` | unfinished deploys, used by the backend's restart reconciliation |
| `POST /deployments/:deploymentId/cancel` | cancel here and on Vercel |
| `PUT /components/:componentId/env?userId=` | Phase 9 hook: upsert env vars on the Vercel project |
| `DELETE /components/:componentId?userId=` | delete the Vercel project; not called by the MVP |

## Checking the Vercel API against your account

Vercel does not document the error it returns when its GitHub app cannot see a repo, so
`isGitAccessError` in `vercel.provider.ts` recognises it by pattern. Step 0 of
`Plans/Plans_Remaining/PLAN_PHASE_6.md` is a spike that records the real answers:

```bash
VERCEL_TOKEN=... SPIKE_REPO=owner/repo SPIKE_REPO_ID=123 SPIKE_BRANCH=main SPIKE_ROOT_DIR=frontend npm run spike
```

The spike creates one throwaway project (`orbitops-spike-*`), exercises the calls, writes redacted
responses to `src/vercel/__fixtures__/`, and deletes the project.

## Tests

```bash
npm run typecheck && npm test
```

The tests cover:
- the pure mappers (framework, settings, names, status, logs) and the HTTP client's retries and
  error mapping;
- the provider against a fake Vercel API: create / update / recreate, the Git → upload fallback,
  missing files;
- credentials: sealed at rest, invalid-token handling, team lock;
- outbox ordering, retries and persistence, and the callback HMAC;
- the queue and runner: resume, cancel vs shutdown, timeout, no token in relayed logs;
- the Fastify API via `inject()`.
