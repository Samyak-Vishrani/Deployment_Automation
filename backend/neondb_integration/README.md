# Neon DB integration service

Phase 8 of `PLAN.md`: provisions a project's **database component** as a Postgres database in the
user's own Neon account, and hands its connection strings to the main backend, which passes them to
the Render backend.

This is a separate service. It sits next to:
- the main backend (`backend/`, Next.js on :3001);
- the Vercel integration (`backend/vercel_integration`, :3002);
- the Render integration (`backend/render_integration`, :3003).

It owns everything Neon-specific:
- the user's Neon API key, and the chosen organization, region and Postgres version;
- the Neon project for each database component;
- fetching the connection strings when the backend asks.

```text
Browser ──► backend :3001 ──x-internal-token (NEON_SERVICE_TOKEN)──► neondb_integration :3004 ──► console.neon.tech/api/v2
                │                         (synchronous: ensure / connection)
                └──► render_integration :3003   deploy request carries DATABASE_URL + DATABASE_URL_UNPOOLED (in memory)
```

- **Stack:** Node 22, TypeScript run with `tsx`, Fastify, Prisma, Vitest.
- **Data:** the same Postgres as the backend, in its own schema (`?schema=neon`). There are no
  foreign keys into anyone else's tables, and nobody else reads these.
- **No imports** from `backend/lib` or the other services. Shared plumbing comes from
  `@orbitops/integration-common` (`backend/integration_common`), linked by `npm install`:
  - the internal-token check;
  - secret-box (`src/crypto/secret-box.ts` holds this service's own instance);
  - redact;
  - the retrying fetch and provider errors;
  - config helpers.
- **Synchronous.** Creating a Neon project takes seconds, so there is no deploy queue, runner,
  outbox or callback: `POST /databases` answers once the database is ready. There is no callback
  secret either.
- **Never stores a connection string.** Neon API keys are sealed at rest. Connection URIs are
  fetched from Neon each time `GET /databases/:componentId/connection` is called.
  - The backend keeps them in memory for one deploy request.
  - A password reset on Neon is picked up automatically.
- **Listens on** `127.0.0.1` only. Every route except `/health` requires `x-internal-token`.

## Run it

```bash
cp .env.example .env        # fill in the secrets (below)
npm install                 # also links ../integration_common
npx prisma migrate deploy   # creates the "neon" schema and its tables
npm run dev                 # tsx watch, :3004
```

| Variable | What |
| --- | --- |
| `NEON_SERVICE_TOKEN` | the same value as in `backend/.env`; at least 32 characters |
| `ENCRYPTION_KEY` | 32 bytes, base64; seals Neon API keys. A key of its own |
| `DATABASE_URL` | the backend's Postgres URL with `?schema=neon` |
| `NEON_PROVISION_TIMEOUT_MS` | optional, default 60000: how long `POST /databases` waits for Neon |
| `DEFAULT_REGION`, `DEFAULT_PG_VERSION` | optional, default `aws-us-west-2` (Oregon) and 17: what a newly connected key starts with |

The service fails at startup with a list of whatever is missing.

**On Neon's side:**
- create an API key at console.neon.tech → Account settings → API keys;
- paste it in OrbitOps Settings → Integrations → Neon.

The free plan has a project limit. Reaching it fails with `neon_project_limit` and says to delete a
project or upgrade.

## How provisioning runs

`POST /databases { userId, componentId, projectName, componentName }` (`src/databases/databases.service.ts`):

1. Calls for one component are serialised, so two at once never create two projects.
2. **No database yet:**
   - `POST /projects` with the name `<project>-<component>`, plus the region, Postgres version and
     organization from Settings.
   - The project id, its default branch, database and owner role are stored straight away, as
     `provisioning`, **before** waiting. An interrupted call is then resumed instead of creating a
     second project.
3. **Already known:**
   - `GET /projects/:id`; a `ready` database answers at once with `created: false`.
   - A project deleted on Neon is created again, **empty**. The answer carries a `warning` that
     says so, and the backend logs it.
   - A project whose setup failed holds no data, so it is deleted and created again.
4. **Waits for Neon's operations** (`GET /projects/:id/operations`, every second) until none is
   scheduled or running:
   - a failed operation → `neon_provision_failed`, and the row is marked `failed`;
   - more than 60 s → `neon_provision_timeout`, and the row stays `provisioning`; the next call
     waits again.
5. Answers `DatabaseView`: the state, project id, name, region, version, host, database and role
   names, and the console URL. Never a password.

`GET /databases/:componentId/connection` calls `GET /projects/:id/connection_uri` twice:
- **pooled**, which becomes the backend's `DATABASE_URL`, for the application;
- **direct**, which becomes `DATABASE_URL_UNPOOLED`, for migrations.

With Prisma:
```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_UNPOOLED")
}
```
Migrations are not run for you: add `npx prisma migrate deploy` (or your ORM's equivalent) to the
backend's build command.

## Internal API

All routes except `/health` need `x-internal-token: <NEON_SERVICE_TOKEN>`.

| Method & path | Purpose |
| --- | --- |
| `GET /health` | liveness + DB check |
| `GET /options` | regions and Postgres versions for Settings |
| `GET /users/:userId/credential` | `{ provider, state, accountName, orgId, orgName, orgs, regionId, pgVersion, scopeLocked, lastValidatedAt }`. Never the key |
| `PUT /users/:userId/credential` | `{ apiKey }`: validated with `GET /users/me` (or `GET /projects` for an organization key), then sealed |
| `PATCH /users/:userId/credential` | `{ orgId?, regionId?, pgVersion? }`. The organization is locked (409) once a database exists |
| `DELETE /users/:userId/credential` | forget the key; projects on Neon are kept |
| `POST /databases` | ensure the database (above), synchronous, ≤ 60 s |
| `GET /databases/:componentId?userId=` | `DatabaseView`, or 404 |
| `GET /databases/:componentId/connection?userId=` | `{ pooledUri, directUri }`. **The only secret-bearing route**: `cache-control: no-store`, never logged |
| `DELETE /databases/:componentId?userId=` | delete the Neon project; not called by the MVP |

Errors are `{ error, message }`:
- `neon_not_connected`, `neon_key_invalid` (412);
- `neon_org_required` (412);
- `neon_project_limit` (409);
- `neon_locked` (409, retryable);
- `neon_provision_failed` (502), `neon_provision_timeout` (504);
- `neon_database_not_ready` (409), `neon_database_gone` (404);
- `neon_forbidden` (403), `neon_rate_limited` (429), `neon_unavailable` (502).

## Step 0: the API spike

`NEON_API_KEY=... npm run spike` creates one throwaway project, records Neon's real answers to
`src/neon/__fixtures__/` (key and passwords removed), and deletes the project. It shows:
- whether `org_id` is required for your key;
- which operation statuses a new project goes through;
- the exact texts of the locked and project-limit errors.

Use them to tighten `PROJECT_LIMIT` and `ORG_REQUIRED` in `src/neon/neon-http.ts`.

## Test

```bash
npm run typecheck
npm test
```
