# Deployment Automation

A developer connects a GitHub repository; a push to its branch builds a Docker image and replaces
the running container, with the build log streamed live to the dashboard. From Phase 6, a
frontend component can instead be deployed to the user's own Vercel account.

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
```

GitHub delivers pushes to a single App-level webhook at `POST /api/webhooks/github`.

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
    projects/[id]/components/   configure components; [cid]/deploy deploys one to its provider  ← phase 5/6
    providers/                  connect / disconnect provider accounts (proxied to the service)  ← phase 6
    internal/provider-events    signed deploy events from the Vercel integration service  ← phase 6
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
    providers/                  Vercel-service client, provider deploys, callback handling  ← phase 6
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
`Plans/Plans_Remaining/PLAN_PHASE_6.md`), run `npm run spike` in `backend/vercel_integration`. The
required variables are at the bottom of its `.env.example`. It creates one throwaway project and
deletes it at the end.

## Tests

```bash
cd backend  && npm test        # 289 unit tests (analysis, detection, components, pre-flight, push filter, GitHub, auth, provider deploys)
cd backend  && npm run test:e2e  # drives the real webhook route against a running backend
cd frontend && npm test
cd backend/vercel_integration && npm test   # Vercel provider, upload, credentials, outbox, runner, API
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

Vercel integration (`backend/vercel_integration/.env`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | the same Postgres, with `?schema=vercel` |
| `ENCRYPTION_KEY` | 32 bytes, base64; seals Vercel tokens; required in production; not the backend's key |
| `INTERNAL_SERVICE_TOKEN` / `INTERNAL_CALLBACK_SECRET` | the same values as in `backend/.env` |
| `MAIN_API_URL` | the backend, for event callbacks; default `http://localhost:3001` |
| `HOST` / `PORT` | default `127.0.0.1:3002`; keep it on loopback |
| `DEPLOY_CONCURRENCY`, `VERCEL_POLL_INTERVAL_MS`, `VERCEL_DEPLOY_TIMEOUT_MIN` | optional tuning (8, 3000, 45) |

Frontend (`frontend/.env`):

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | backend origin |
| `NEXT_PUBLIC_DATA_MODE` | `mock` keeps the dashboard on fixtures; the `/deploy` screens always use the real API |
