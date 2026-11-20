# Deployment Automation

A developer connects a GitHub repository; a push to its branch builds a Docker image and replaces
the running container, with the build log streamed live to the dashboard. From Phase 6, a
frontend component can instead be deployed to the user's own Vercel account, and from Phase 7 a
backend component to the user's own Render account. From Phase 8 a database component is provisioned
as Postgres in the user's own Neon account, and **Deploy all** ships the whole project in order:
database → backend (with `DATABASE_URL`) → frontend (with the backend's URL).

## Architecture

```text
Browser
  ↓
Frontend :3000            Next.js — dashboard, /deploy screens
  ↓ HTTP + SSE
Backend  :3001            Next.js route handlers — API, webhook, deploy pipeline
  ↓
Prisma → PostgreSQL :5433
  ↓
Docker daemon             build + run each project's container on 127.0.0.1:5000-5999

Backend :3001  ⇄  Vercel integration :3002   backend/vercel_integration — its own service
                    ↓                          (Fastify + Prisma, Postgres schema "vercel")
                  Vercel REST API             projects, deploys, status, build logs

Backend :3001  ⇄  Render integration :3003   backend/render_integration — its own service
                    ↓                          (Fastify + Prisma, Postgres schema "render")
                  Render REST API             web services, env vars, deploys, status, logs

Backend :3001  →  Neon DB integration :3004  backend/neondb_integration — its own service
                    ↓                          (Fastify + Prisma, Postgres schema "neon"; synchronous)
                  Neon REST API               projects, operations, connection strings

Backend :3001  ⇄  Logs :3005                 backend/logs — its own service (Fastify, files, no database)
                    ↓                          build logs (JSONL per deployment) + live runtime tails
                  /log-proxy on :3002 / :3003  read-only routes that add the provider token (Phase 12)

Backend :3001  →  AI :3006                   backend/ai — its own service (Fastify + Prisma, Postgres schema "ai")
                    ↓                          rules → token budget → combined timeline → prompt → validate
                  OpenAI gpt-4o-mini          structured output; the only holder of OPENAI_API_KEY (Phase 13)

backend/integration_common                    shared plumbing the services import (no process)
```

GitHub delivers pushes to a single App-level webhook at `POST /api/webhooks/github`.

The Vercel integration is a separate process that only the backend talks to. The backend calls it
with a shared `INTERNAL_SERVICE_TOKEN`; it posts deploy events back to
`POST /api/internal/provider-events`, signed with `INTERNAL_CALLBACK_SECRET`. It stores Vercel
tokens (encrypted), the Vercel project per component and its own deploy state in the `vercel`
schema; the backend keeps the `Deployment` rows, the log files and the live `/events` feed. See
`backend/vercel_integration/README.md`.

The Render integration works the same way with its **own** secrets: the backend calls it with
`RENDER_SERVICE_TOKEN`, and its events are signed with `RENDER_CALLBACK_SECRET` and tagged
`x-orbitops-provider: render`, so neither service can report on the other's deployments. See
`backend/render_integration/README.md`.

The Neon DB integration has its own `NEON_SERVICE_TOKEN` and sends nothing back: provisioning is
synchronous (seconds), so the backend just waits for `POST /databases`. It never stores a
connection string. The backend asks for one when it deploys the backend to Render, keeps it in
memory for that one request, and Render receives it as `DATABASE_URL`. See
`backend/neondb_integration/README.md`.

The plumbing all three services need (the internal-token check, secret-box, redaction, the
retrying fetch, provider errors, the callback client, outbox and deploy queue) lives once in
`backend/integration_common`. Each service links it with `npm install` (`file:../integration_common`).
See `backend/integration_common/README.md`.

## Backend layout

```text
backend/
  app/api/
    webhooks/github/            HMAC verification, delivery dedupe, fire-and-forget handoff
    projects/                   CRUD, manual deploy, rollback, deployment history
    deployments/[id]/           detail, cancel, log text, live log stream (SSE)
    events/                     app-wide change feed (SSE)
    projects/[id]/analyze       run the repository analysis  ← phase 4
    projects/[id]/analysis      latest analysis snapshot  ← phase 4
    repositories/               the user's repos and branches, read live from GitHub  ← phase 3
    auth/github/                sign-in through the GitHub App; also where installs land
    projects/[id]/components/   configure components; [cid]/deploy deploys one to its provider  ← phase 5/6/7/8
    projects/[id]/releases      "Deploy all": database → backend → frontend as one release  ← phase 8
    releases/[id]/              a release with its steps; cancel  ← phase 8
    providers/                  connect / disconnect Vercel, Render and Neon accounts (proxied to their services)  ← phase 6/7/8
    internal/provider-events    signed deploy events from the integration services (secret per provider)  ← phase 6/7
  lib/
    github/github-app.service   App JWT → installation token, repo metadata, branch SHA, source tarball
    github/github.service       tree + file reads at a commit SHA  ← phase 4
    github/github-user.service  user-token calls: installations, repos, branches, access check
    crypto/secret-box           AES-256-GCM for secrets at rest (user GitHub tokens)
    github/source-archive       tarball download + extract, shared by deploys and analysis
    webhooks/                   signature, delivery-store
    deployments/                push filter, queue, executor, log writer
    docker/                     container lifecycle
    projects/                   port allocator, validation
    analysis/                   framework detection, build settings, database hints  ← phase 4
    components/                 component config, provider rules, pre-flight  ← phase 5
    providers/                  integration-service clients (Vercel, Render, Neon), provider deploys, env injection, callbacks  ← phase 6/7/8
    releases/                   the Deploy-all orchestrator: stages, resume after restart  ← phase 8
    runtime.ts                  process-wide service graph + startup reconciliation
```

The deploy pipeline was carried over from a NestJS prototype and ported onto Next.js route
handlers. NestJS's DI container and lifecycle hooks have no equivalent here, so the singletons live
in `lib/runtime.ts`, parked on `globalThis` so a hot reload cannot hand a request a fresh, empty
queue while the old one is still building.

## Local development

Start Postgres:

```bash
docker compose up -d
```

Terminal 1:

```bash
cd backend
cp .env.example .env     # then fill in the GitHub App values
npm install
npm run prisma:migrate
npm run dev              # :3001
```

Terminal 2:

```bash
cd frontend
cp .env.example .env
npm install
npm run dev              # :3000
```

Terminal 3 (Vercel deploys, Phase 6):

```bash
cd backend/vercel_integration
cp .env.example .env     # then fill in the secrets, see "Vercel setup"
npm install
npx prisma migrate deploy  # creates the "vercel" schema
npm run dev              # :3002
```

Terminal 4 (Render deploys, Phase 7):

```bash
cd backend/render_integration
cp .env.example .env     # then fill in the secrets, see "Render setup"
npm install
npx prisma migrate deploy  # creates the "render" schema
npm run dev              # :3003
```

Terminal 5 (Neon databases, Phase 8):

```bash
cd backend/neondb_integration
cp .env.example .env     # then fill in the secrets, see "Neon setup"
npm install
npx prisma migrate deploy  # creates the "neon" schema
npm run dev              # :3004
```

Terminal 6 (logs, Phase 12):

```bash
cd backend/logs
cp .env.example .env     # then fill in the two tokens, see "Logs"
npm install
npm run dev              # :3005
```

Terminal 7 (AI assistant, Phase 13):

```bash
cd backend/ai
cp .env.example .env     # then fill in the token and OPENAI_API_KEY, see "AI assistant"
npm install
npx prisma migrate deploy  # creates the "ai" schema
npm run dev              # :3006
```

`backend/integration_common` is not started: `npm install` in each service links it. Run
`npm install` there too if you want to run its own tests.

## GitHub App setup

One GitHub App does both jobs. The push pipeline authenticates as an *installation*, so a
webhook-triggered build can fetch source with nobody signed in. Sign-in uses the same App's
client id, and the user token it returns lists the repositories that user can connect.

1. Create a GitHub App. Users install it from the "Connect a repository" screen.
2. Set its webhook URL to your public tunnel, ending in `/api/webhooks/github`.
   A VS Code dev tunnel must be set to **public** — a private one answers GitHub with a sign-in
   page, so every delivery fails while still looking like it was accepted.
3. Copy the app id, slug, webhook secret and private key into `backend/.env`.
   The PEM goes on one line with real newlines written as `\n`.
4. On the App's settings page:
   - **Callback URL** → `http://localhost:3001/api/auth/github/callback`
   - tick **Request user authorization (OAuth) during installation**, so installing also signs in
   - leave **Expire user authorization tokens** on
   - **Account permissions → Email addresses: Read-only**, so sign-in gets the verified email
   - **Generate a new client secret**; put it and the App's client id in
     `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`
5. Set `ENCRYPTION_KEY` (the command is in `.env.example`). It seals the users' GitHub tokens.

The private key is a credential: it is covered by `.gitignore` (`*.pem`, `.env`) and must never be
committed.

## Vercel setup

Frontend components deploy to the user's own Vercel account. The Vercel code is a separate service
in `backend/vercel_integration`; the backend reaches it on `127.0.0.1:3002`.

1. Generate two shared secrets and put the **same** values in `backend/.env` and
   `backend/vercel_integration/.env`:
   - `INTERNAL_SERVICE_TOKEN`: the backend sends it on every call to the service.
   - `INTERNAL_CALLBACK_SECRET`: signs the deploy events the service posts back.

   Generate each with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Set `ENCRYPTION_KEY` in `backend/vercel_integration/.env`, a different key from the backend's.
   It seals the users' Vercel tokens.
3. Start the service (Terminal 3 above), then in the dashboard go to **Settings → Integrations**.
   Paste a Vercel access token created at <https://vercel.com/account/tokens>, scoped to the team
   you deploy to. The token is validated with Vercel and stored encrypted; it is never shown again.
4. *Recommended:* install **Vercel's GitHub app** on the repositories you deploy. Vercel then
   builds straight from GitHub. Without it, every deploy downloads the commit and uploads the files,
   which is slower and limited to 100 MB / 15,000 files.
5. For projects it creates, OrbitOps switches off Vercel's own deploy-on-push. Deploy from the
   dashboard; once a component has been deployed, a push that changes its folder redeploys it.

The Vercel token is a credential, as are both shared secrets: keep them out of git (`.env` is
ignored in both folders).

To check how the real Vercel API answers for your account (step 0 of
`Plans/Plans_Executed/PLAN_PHASE_6.md`), run `npm run spike` in `backend/vercel_integration`. The
required variables are at the bottom of its `.env.example`. It creates one throwaway project and
deletes it at the end.

## Render setup

Backend components deploy to the user's own Render account. The Render code is a separate service
in `backend/render_integration`; the backend reaches it on `127.0.0.1:3003`.

1. Generate two **new** shared secrets (not the Vercel ones) and put the same values in
   `backend/.env` and `backend/render_integration/.env`:
   - `RENDER_SERVICE_TOKEN`: the backend sends it on every call to the service.
   - `RENDER_CALLBACK_SECRET`: signs the deploy events the service posts back.

   Generate each with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Set `ENCRYPTION_KEY` in `backend/render_integration/.env`, a key different from every other one.
   It seals the users' Render API keys.
3. Run `npx prisma migrate deploy` in `backend` (adds `Component.healthCheckPath`) and in
   `backend/render_integration` (creates the `render` schema), then start the service (Terminal 4).
4. **Connect Render to GitHub.** Render builds from GitHub itself, so in Render go to
   **Account Settings → Git** (dashboard.render.com), connect GitHub and give Render access to the
   repositories you deploy. There is no upload fallback as there is for Vercel.
5. In the dashboard, go to **Settings → Integrations**. Paste a Render API key (create one at
   <https://dashboard.render.com/u/settings#api-keys>), then pick the workspace, region and plan.
   Free instances sleep after 15 minutes without traffic and take about a minute to wake.
6. On a project's **Configure** page, the Backend card needs a framework Render can run
   (express, nestjs, fastapi…) and a **start command**; the server must listen on
   `process.env.PORT`. A **health check path** (e.g. `/health`) is optional.
7. The project's env vars (set when connecting the repository) are sent to Render on every deploy;
   values are never logged. Variables you add by hand on Render's dashboard are left alone.
8. For services it creates, OrbitOps switches off Render's auto-deploy. Deploy from the dashboard;
   once a component has been deployed, a push that changes its folder redeploys it.

The Render API key is a credential, as are both shared secrets: keep them out of git.

To check how the real Render API answers for your account (step 0 of
`Plans/Plans_Executed/PLAN_PHASE_7.md`), run `npm run spike` in `backend/render_integration`. The
required variables are at the bottom of its `.env.example`. It creates one throwaway free service
and deletes it at the end.

## Neon setup

Database components are provisioned as Postgres in the user's own Neon account. The Neon code is a
separate service in `backend/neondb_integration`; the backend reaches it on `127.0.0.1:3004`.

1. Generate one **new** shared token and put the same value in `backend/.env` and
   `backend/neondb_integration/.env` as `NEON_SERVICE_TOKEN`. There is no callback secret: this
   service never calls the backend.
2. Set `ENCRYPTION_KEY` in `backend/neondb_integration/.env`, a key different from every other one.
   It seals the users' Neon API keys.
3. Run `npx prisma migrate deploy` in `backend`, which adds the `Release` table and
   `Deployment.releaseId`, and in `backend/neondb_integration`, which creates the `neon` schema.
   Start the service (Terminal 5).
4. In the dashboard, go to **Settings → Integrations**. Paste a Neon API key (create one at
   <https://console.neon.tech/app/settings/api-keys>), then pick:
   - the organization (if the key sees several);
   - the region: Oregon, `aws-us-west-2`, by default, next to Render's default region;
   - the Postgres version.
5. On a project's **Configure** page, tick **Add database (Neon)** (analysis adds it when it sees
   Postgres) and save. **Provision on Neon** creates the database. Any later backend deploy gets
   two env vars:
   - `DATABASE_URL`: pooled, for the application;
   - `DATABASE_URL_UNPOOLED`: direct, for migrations.

   They override the project's own values of the same name. They are never stored by OrbitOps and
   never logged.
6. **Migrations are not run for you.** Add one to the backend's build command, e.g.
   `npm install && npx prisma migrate deploy`. With Prisma, point the direct URL at the unpooled
   variable:

   ```prisma
   datasource db {
     provider  = "postgresql"
     url       = env("DATABASE_URL")
     directUrl = env("DATABASE_URL_UNPOOLED")
   }
   ```
7. Neon's free plan limits the number of projects, and free computes pause when idle: the first
   query after a pause takes a moment.

To check how the real Neon API answers for your account (step 0 of
`Plans/Plans_Remaining/PLAN_PHASE_8.md`), run `NEON_API_KEY=... npm run spike` in
`backend/neondb_integration`. It creates one throwaway project and deletes it at the end.

## Deploy all

Once every pre-flight check passes, **Configure** and the project page show **Deploy all**. One
click creates a **Release**, pinned to the branch head's commit, and runs it in three steps. Each
step starts only when every deployment of the one before is live:

1. **Database:** the Neon project is provisioned, or found if it already exists.
2. **Backend:** deployed to Render with `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
3. **Frontend:** deployed to Vercel. The backend's `*.onrender.com` URL is first set on the Vercel
   project, under the key the framework exposes to browser code:
   - Next.js: `NEXT_PUBLIC_API_URL`;
   - Vite, Vue and React with Vite: `VITE_API_URL`;
   - Nuxt: `NUXT_PUBLIC_API_URL`;
   - Astro and SvelteKit: `PUBLIC_API_URL`;
   - Create React App: `REACT_APP_API_URL`;
   - anything else: `API_URL`.

   This happens only with exactly one backend.

A failed or cancelled step ends the release, and later steps never start. The release is shown on
the project page with a link to each step's log. If the backend restarts mid-release, the release
carries on. Pushes still redeploy single components, and they get the same env vars.

## Environment variables

Since Phase 9, env vars live in the `EnvVar` table, and every value is encrypted with
`ENCRYPTION_KEY` (AES-256-GCM, `lib/crypto/secret-box.ts`). Edit them on **Configure**:
- each frontend and backend card has an **Environment** section;
- the **Shared env vars** panel goes to every backend and to local Docker deploys.

A component's own variable beats a shared one with the same name.

| Component | Receives |
| --- | --- |
| Render backend | shared + its own, as plain Render env vars, plus Neon's `DATABASE_URL` / `DATABASE_URL_UNPOOLED` |
| Vercel frontend | its own only: secrets as **Sensitive** (write-only) vars, the rest as **Encrypted**, for production and preview; plus the backend's URL |
| Local Docker deploy | shared, as runtime env of the container (never `--build-arg`) |
| Neon database | nothing: its connection string goes to the backend |

- **Secret or not.** New rows are secrets by default. Pasting a `.env` or **Add from
  .env.example** guesses from the name (`SECRET`, `TOKEN`, `KEY`, `PASSWORD`, `DATABASE_URL`…).
  - A secret is write-only: it can be replaced, never shown again.
  - A non-secret can be shown with **Show**.
  - Turning a secret into a non-secret needs the value entered again.
  - On a frontend, `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*`, `PUBLIC_*` and `NUXT_PUBLIC_*` cannot be
    secrets, because the framework puts them in browser code.
- **System variables** are shown read-only and never stored:
  - `DATABASE_URL` / `DATABASE_URL_UNPOOLED` from Neon replace a value of the same name;
  - for the backend's URL (e.g. `NEXT_PUBLIC_API_URL`), **your** value wins. That is how a project
    with several backends sets it.
- **Changes apply on the next deploy.** Saving only stores them. A deployed component then shows
  **Env changed — redeploy to apply**, with **Save & redeploy** in the editor.
- **Limits:**
  - names are letters, digits and `_`;
  - values are up to 32 KB each, and may be multi-line;
  - at most 100 per component;
  - 64 KB in total on Vercel.
- **Keys the provider sets itself are refused:** `VERCEL_*` and the AWS runtime names on Vercel,
  and `RENDER` / `RENDER_*` on Render.
- **Values never appear** in an API response other than **Show**, in a log line, or in an error.
- **Upgrading from Phase 8:** on its first start, the backend moves each project's old
  `Project.envVars` into shared rows, as secrets. The old column is then left empty.

To give the backend the frontend's URL (e.g. for CORS), add it yourself as a backend variable, such
as `CORS_ORIGIN=https://<project>.vercel.app`.

## Logs

All log code lives in one service, `backend/logs` (:3005). Every view shows **one** component
(or one deployment) at a time: Vercel's and Render's logs are never mixed. The combined,
time-ordered log exists only inside the AI assistant's prompt (Phase 13), which reads
errors-first excerpts and runtime snapshots from this service.

| View | Where | Stored? |
| --- | --- | --- |
| **Build** | the build page, and **Logs → \<component\> → Build** with a deployment picker | Yes: `backend/logs/data/<projectId>/<deploymentId>.jsonl` |
| **Runtime** | **Logs → \<component\> → Runtime** | No: tailed live only while you watch |

**Build logs**
- Each line records its **source** (`orbitops` for our own steps, `vercel`, `render`, `neon` or
  `docker`), its phase, stdout/stderr and time.
- The viewer has source chips, **Errors only** (errors are tinted, counted and reachable with
  ↑/↓), search, wrap, **Copy** and **Download**.
- A reconnect resumes from the last line (`Last-Event-ID`), with no gaps and no repeats.
- Logs from before Phase 12 (`backend/data/logs/**/*.log`) are still read.
- **If the logs service is down, deploys still work:** the backend buffers up to 5000 lines per
  deployment and delivers them when it is back.

**Runtime logs** come from a different place per provider:
- **Render:** app logs, plus request lines if asked, through `render_integration`'s log proxy.
  Render's API allows **30 log reads a minute**, so it is read every 3 s, newest 100 lines first,
  and slows down when the quota runs low.
- **Vercel:** the runtime-logs stream of the live deployment, through `vercel_integration`'s proxy.
  Vercel only sends something when a server function or middleware runs; a site of static pages
  logs nothing at runtime.
- **Neon:** has no runtime log API; the tab says so.
- **Local Docker:** `docker logs --follow` of `orbitops-<slug>`.

Runtime limits: at most 3 open streams per user. A stream ends after 15 minutes without a viewer
(the page pings while visible) or 60 minutes in total, and then shows **Resume**.

**Redaction**
- Build lines are redacted by the backend before they are sent; runtime lines are redacted with
  the component's secret env values.
- The logs service redacts known token shapes again.
- Provider tokens never reach the logs service: the integration services' `/log-proxy` routes
  add them, and accept only `LOGS_PROXY_TOKEN`, which opens nothing else.

**Setup**
1. Generate two **new** tokens. Put `LOGS_SERVICE_TOKEN` in `backend/.env` and
   `backend/logs/.env`. Put `LOGS_PROXY_TOKEN` in `backend/logs/.env`,
   `backend/vercel_integration/.env` and `backend/render_integration/.env`.
2. Start Terminal 6, and restart the Vercel and Render services so they read `LOGS_PROXY_TOKEN`.

## AI assistant

On demand only: nothing runs until you click, and nothing is ever changed for you.

| Button | Where | Looks at |
| --- | --- | --- |
| **Diagnose with AI** | the project page (header, and the AI assistant section) | the whole project: every component's settings, last 5 deployments, latest build log excerpt and runtime snapshot; the latest Deploy all; pre-flight; the repo analysis; env var **keys**; and a combined, time-ordered timeline of all of it |
| **Analyze** | a component row; **Logs → \<component\>**; the build page (**Ask AI why it failed**) | one entity on its own (Vercel, Render, Neon, or the local Docker deploys), with a bigger log budget, its last successful build for comparison, and its provider's known failure modes |

Each answer has a verdict (*healthy*, *degraded*, *failing*, *unknown*), the problems found (with
the components, the root cause, a confidence and the log lines that show it, each linking to that
log), the ordered steps to fix them (and where: Configure, Environment, Settings, the repository,
the provider dashboard, redeploy), and a status per component. An optional question (up to 500
characters) focuses it.

**How it works.** The backend checks ownership and builds the context bundle (it can read the
database, env var keys and pre-flight; the AI service cannot). Log content comes from
`backend/logs` as errors-first excerpts: every error line with 5 lines either side, the first 20
and last 150 lines, repeats collapsed. `backend/ai` then runs rule-based checks (missing env var,
port binding, start command, database connection, API URL, CORS, out of memory, …) as hypotheses,
trims the bundle to about 24k tokens, and asks `gpt-4o-mini` for a strictly-typed JSON answer.
Every quoted log line is checked against the real logs; one that is not there is dropped, and its
problem marked unverified. Destructive or secret-writing commands are removed.

**What is sent to OpenAI:** redacted logs, settings and env var **keys**. Never env var values,
connection strings or provider tokens: the backend scrubs every secret env value of the project
and any `user:password@` from the whole bundle, and the AI service redacts again before sending.

**Without `OPENAI_API_KEY`**, or when OpenAI fails, you still get a rule-based answer, labelled
"rules only", with the reason.

**Limits:** 20 analyses an hour and 100 a day per user; one at a time per project. The same
question about an unchanged project within 10 minutes returns the stored answer (`cached`);
**Re-run** asks again.

**Setup**
1. Generate a new token for `AI_SERVICE_TOKEN` and put it in `backend/.env` and `backend/ai/.env`.
2. Put your `OPENAI_API_KEY` in `backend/ai/.env` (the model is `OPENAI_MODEL`, default
   `gpt-4o-mini`). `npm run spike` in `backend/ai` checks the key, the model and the cost of one call.
3. `npx prisma migrate deploy` in `backend/ai`, then start Terminal 7.

## Tests

```bash
cd backend  && npm test        # 389 unit tests (analysis, detection, components, pre-flight, push filter, GitHub, auth, provider deploys, releases, env vars, logs seam)
cd backend  && npm run test:e2e  # drives the real webhook route against a running backend
cd frontend && npm test
cd backend/vercel_integration && npm test   # Vercel provider, upload, credentials, outbox, runner, API
cd backend/render_integration && npm test   # Render provider, env sync, credentials, outbox adapter, runner, API
cd backend/neondb_integration && npm test   # Neon provider, provisioning, credentials, API
cd backend/integration_common && npm test   # shared plumbing: secret-box, outbox, queue, fetch, callbacks, env vault + hash, ndjson
cd backend/logs && npm test                 # log store, ingest + stream routes, Render/Vercel/Docker tailers, sessions, AI excerpts + snapshots
cd backend/ai && npm test                   # rules, budget, timeline, prompts, validation + evidence guard, cache, limits, rule-based fallback
```

The e2e script signs real HMAC payloads and asserts on the resulting database rows, so it covers
signature verification, delivery dedupe, the fan-out query and the watch-path filter end to end.

## Environment

Backend (`backend/.env`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres, port 5433 to avoid colliding with a local install |
| `FRONTEND_URL` | CORS origin for the dashboard |
| `AUTH_SECRET` | signs the session cookie; required in production |
| `ENCRYPTION_KEY` | 32 bytes, base64; seals stored GitHub tokens; required in production |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | the GitHub App's own client id and secret, for sign-in |
| `GITHUB_OAUTH_CALLBACK_URL` | optional; defaults to `http://localhost:3001/api/auth/github/callback` |
| `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` / `GITHUB_APP_SLUG` | GitHub App |
| `GITHUB_INSTALLATION_ID` | optional; pins the installation instead of resolving per repository |
| `PORT_RANGE_START` / `PORT_RANGE_END` | host ports handed to deployed containers |
| `DEPLOY_CONCURRENCY` | parallel builds; per-project builds are always serialised |
| `DATA_DIR` | build workspaces and deployment logs |
| `VERCEL_SERVICE_URL` | the Vercel integration service; default `http://127.0.0.1:3002` |
| `INTERNAL_SERVICE_TOKEN` | shared with the service; sent on every call to it |
| `INTERNAL_CALLBACK_SECRET` | shared with the service; verifies its deploy events |
| `RENDER_SERVICE_URL` | the Render integration service; default `http://127.0.0.1:3003` |
| `RENDER_SERVICE_TOKEN` | shared with the Render service only; sent on every call to it |
| `RENDER_CALLBACK_SECRET` | shared with the Render service only; verifies its deploy events |
| `NEON_SERVICE_URL` | the Neon DB integration service; default `http://127.0.0.1:3004` |
| `NEON_SERVICE_TOKEN` | shared with the Neon service only; sent on every call to it |
| `LOGS_SERVICE_URL` | the logs service; default `http://127.0.0.1:3005` |
| `LOGS_SERVICE_TOKEN` | shared with the logs service only; sent on every call to it |
| `AI_SERVICE_URL` | the AI service; default `http://127.0.0.1:3006` |
| `AI_SERVICE_TOKEN` | shared with the AI service only; sent on every call to it |

Vercel integration (`backend/vercel_integration/.env`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | the same Postgres, with `?schema=vercel` |
| `ENCRYPTION_KEY` | 32 bytes, base64; seals Vercel tokens; required in production; not the backend's key |
| `INTERNAL_SERVICE_TOKEN` / `INTERNAL_CALLBACK_SECRET` | the same values as in `backend/.env` |
| `MAIN_API_URL` | the backend, for event callbacks; default `http://localhost:3001` |
| `HOST` / `PORT` | default `127.0.0.1:3002`; keep it on loopback |
| `DEPLOY_CONCURRENCY`, `VERCEL_POLL_INTERVAL_MS`, `VERCEL_DEPLOY_TIMEOUT_MIN` | optional tuning (8, 3000, 45) |

Render integration (`backend/render_integration/.env`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | the same Postgres, with `?schema=render` |
| `ENCRYPTION_KEY` | 32 bytes, base64; seals Render API keys; required in production; a key of its own |
| `RENDER_SERVICE_TOKEN` / `RENDER_CALLBACK_SECRET` | the same values as in `backend/.env` |
| `MAIN_API_URL` | the backend, for event callbacks; default `http://localhost:3001` |
| `HOST` / `PORT` | default `127.0.0.1:3003`; keep it on loopback |
| `DEPLOY_CONCURRENCY`, `RENDER_POLL_INTERVAL_MS`, `RENDER_DEPLOY_TIMEOUT_MIN` | optional tuning (8, 3000, 45) |

Neon DB integration (`backend/neondb_integration/.env`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | the same Postgres, with `?schema=neon` |
| `ENCRYPTION_KEY` | 32 bytes, base64; seals Neon API keys; required in production; a key of its own |
| `NEON_SERVICE_TOKEN` | the same value as in `backend/.env` |
| `HOST` / `PORT` | default `127.0.0.1:3004`; keep it on loopback |
| `NEON_PROVISION_TIMEOUT_MS`, `DEFAULT_REGION`, `DEFAULT_PG_VERSION` | optional (60000, `aws-us-west-2`, 17) |

Logs (`backend/logs/.env`):

| Variable | Purpose |
| --- | --- |
| `LOGS_SERVICE_TOKEN` | the same value as in `backend/.env` |
| `LOGS_PROXY_TOKEN` | the same value as in `vercel_integration/.env` and `render_integration/.env`; must differ from every internal token |
| `VERCEL_SERVICE_URL`, `RENDER_SERVICE_URL` | the integration services (`http://127.0.0.1:3002`, `:3003`) |
| `DATA_DIR` | where build logs are written (default `./data`) |
| `LEGACY_LOG_DIR` | pre-Phase-12 logs, read only (default `../data/logs`) |
| `HOST` / `PORT` | default `127.0.0.1:3005`; keep it on loopback |
| `MAX_LOG_BYTES`, `RUNTIME_STREAM_MAX_MS`, `RUNTIME_IDLE_MS`, `RENDER_RUNTIME_POLL_MS`, `MAX_STREAMS_PER_USER` | optional (20 MB, 60 min, 15 min, 3000, 3) |

AI (`backend/ai/.env`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | the same Postgres, with `?schema=ai` |
| `AI_SERVICE_TOKEN` | the same value as in `backend/.env` |
| `OPENAI_API_KEY` | optional; without it every analysis is rule-based |
| `OPENAI_MODEL` | default `gpt-4o-mini` |
| `OPENAI_BASE_URL`, `OPENAI_TIMEOUT_MS` | optional (OpenAI's API, 45000) |
| `HOST` / `PORT` | default `127.0.0.1:3006`; keep it on loopback |
| `AI_MAX_INPUT_TOKENS`, `AI_MAX_OUTPUT_TOKENS`, `AI_RATE_HOUR`, `AI_RATE_DAY`, `AI_CACHE_MINUTES` | optional (24000, 2500, 20, 100, 10) |

`vercel_integration/.env` and `render_integration/.env` also take `LOGS_PROXY_TOKEN`. Leaving it
unset turns their `/log-proxy` routes off, and runtime logs then answer 503.

Frontend (`frontend/.env`):

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | backend origin |
| `NEXT_PUBLIC_DATA_MODE` | `mock` keeps the dashboard on fixtures; the `/deploy` screens always use the real API |
