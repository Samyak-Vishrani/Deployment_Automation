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
- **Imports:** none from `backend/lib` or the other services. The plumbing every integration
  shares (internal-token check, secret-box, redact, retrying fetch, provider errors, callback
  client, outbox, deploy queue, event contract) comes from `@orbitops/integration-common`
  (`backend/integration_common`), linked by `npm install` as `file:../integration_common`.
  `fs-utils` is still a copy of the backend's, because only this service needs it.
- **Superseded copies:** files named `xxx_*` are the old copies replaced by
  `integration_common`. They are kept for review, excluded from `tsc` and Vitest, and can be
  deleted.
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

1. **The backend sends `POST /deployments`.** The body holds:
   - the component's build settings;
   - the repo and the exact commit SHA;
   - a short-lived GitHub installation token;
   - since Phase 8, `publicEnvVars`: the backend's URL under the key the framework reads, e.g.
     `NEXT_PUBLIC_API_URL`.

   The service stores everything except the token and returns 202.
   - `publicEnvVars` are public values (they end up in the browser bundle), so they are stored and
     may be logged.
   - Keys that look like secrets (`SECRET`, `TOKEN`, `KEY`, `PASSWORD`…) are refused.
   - Absent means the project's env vars are left alone.
   - Since Phase 9, `envVars`: the frontend's own variables, `{ key, value, secret }`. They are
     **never stored**: they are held in memory (`EnvVault` from `integration_common`) until the
     run takes them, and only their keys are kept (`input.envKeys`). Absent means the project's
     user vars are left alone.
2. **Public env vars are set before the deploy**, because frameworks inline them at build time:
   - they are upserted as plain `production` + `preview` vars;
   - keys this service set before and no longer sends are removed;
   - variables added on Vercel's dashboard are never touched;
   - an unchanged set (`VercelProject.envHash`) costs no API call.

   The user's own `envVars` follow (Phase 9):
   - secrets are set as **sensitive** (write-only on Vercel too), the rest as **encrypted**, for
     `production` + `preview`;
   - keys set before and no longer sent are deleted, and a key whose secret flag flipped is deleted
     and created again, because Vercel cannot turn a Secret into a Config var in place;
   - an unchanged set (`VercelProject.userEnvHash`) costs no API call;
   - the log names keys only, and every value is scrubbed from the build log relayed back;
   - a run that has `envKeys` but lost its values (the vault's hour ran out, or a restart) fails
     with `vercel_interrupted` ("deploy again").
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

### Log proxy (Phase 12)

`GET /log-proxy/components/:componentId/runtime-logs?userId=` is for `backend/logs` only, which
holds all the log code. It is read-only:
- **Auth:** it takes `x-logs-token: <LOGS_PROXY_TOKEN>`. The internal token does not open it, and
  `LOGS_PROXY_TOKEN` opens nothing else. Unset = 503.
- **Upstream:** it looks up the component's live deployment, adds the user's token, and pipes
  Vercel's runtime-log stream back unchanged.
- **Behaviour:** Vercel answers only once there is a log line. Closing the request closes the
  upstream.

Build logs during a deploy keep flowing through the runner, as before. Since Phase 12 every line
says whether this service wrote it (`origin: "orbitops"`) or pulled it from Vercel
(`origin: "provider"`, with `phase`).

`npm run spike:runtime` (`scripts/runtime-logs-spike.ts`) records what the real runtime-logs
stream sends for a deployment.

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
