# Deployment Automation

A developer connects a GitHub repository; a push to its branch builds a Docker image and replaces
the running container, with the build log streamed live to the dashboard.

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
    projects/[id]/analyze       repository analysis  ← phase 4
  lib/
    github/github-app.service   App JWT → installation token, repo metadata, source tarball
    github/github.service       tree + file reads with a user token  ← phase 4
    webhooks/                   signature, delivery-store
    deployments/                push filter, queue, executor, log writer
    docker/                     container lifecycle
    projects/                   port allocator, validation
    analysis/                   framework detection  ← phase 4
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

## GitHub App setup

The push pipeline authenticates as a GitHub App installation, not as a user, so a
webhook-triggered build can fetch source with nobody signed in.

1. Create a GitHub App and install it on the repositories you want to deploy.
2. Set its webhook URL to your public tunnel, ending in `/api/webhooks/github`.
   A VS Code dev tunnel must be set to **public** — a private one answers GitHub with a sign-in
   page, so every delivery fails while still looking like it was accepted.
3. Copy the app id, slug, webhook secret and private key into `backend/.env`.
   The PEM goes on one line with real newlines written as `\n`.

The private key is a credential: it is covered by `.gitignore` (`*.pem`, `.env`) and must never be
committed.

## Tests

```bash
cd backend  && npm test        # 59 unit tests (analysis, detection, push filter, GitHub config)
cd backend  && npm run test:e2e  # drives the real webhook route against a running backend
cd frontend && npm test
```

The e2e script signs real HMAC payloads and asserts on the resulting database rows, so it covers
signature verification, delivery dedupe, the fan-out query and the watch-path filter end to end.

## Environment

Backend (`backend/.env`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres, port 5433 to avoid colliding with a local install |
| `FRONTEND_URL` | CORS origin for the dashboard |
| `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` / `GITHUB_APP_SLUG` | GitHub App |
| `GITHUB_INSTALLATION_ID` | optional; pins the installation instead of resolving per repository |
| `PORT_RANGE_START` / `PORT_RANGE_END` | host ports handed to deployed containers |
| `DEPLOY_CONCURRENCY` | parallel builds; per-project builds are always serialised |
| `DATA_DIR` | build workspaces and deployment logs |

Frontend (`frontend/.env`):

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | backend origin |
| `NEXT_PUBLIC_DATA_MODE` | `mock` keeps the dashboard on fixtures; the `/deploy` screens always use the real API |
