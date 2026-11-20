# Phase 9 — Environment Variables: implementation plan

> **Status: code implemented and tested (2026-11-04); not yet verified live.**
>
> | Step | State | Where |
> |---|---|---|
> | 0. Docs check | ✅ | Findings at the top of `backend/lib/env/env-rules.ts`. Vercel "Secret" = API type `sensitive`, now allowed in every target; a Secret cannot become Config in place; 64 KB per deployment; reserved AWS runtime names + `VERCEL_*`. Render: `RENDER`/`RENDER_*`; no documented size limit |
> | 1. Schema + migration | ✅ | `EnvVar`, `Component.envRevision`, `Deployment.envRevision`; migration `202611040001_env_vars` with the partial index `EnvVar_shared_key`; applied locally |
> | 2. Legacy move | ✅ | `EnvVarsService.migrateLegacy()` at bootstrap. One local project (`Vercel_Integration_test`, key `GREETING`) moves on the next backend start |
> | 3. `lib/env/` | ✅ | `env-rules.ts`, `env-input.ts`, `env-file.ts`, `system-env.ts`, `env-vars.service.ts` |
> | 4. Routes | ✅ | 6 routes under `app/api/projects/[projectId]/…/env` |
> | 5. Deploy paths | ✅ | Render, Vercel and Docker read `resolve()`; `ProviderLogSink.addSecrets`; `Deployment.envRevision`; `projectEnvVars()` removed |
> | 6. `vercel_integration` | ✅ | `envVars` held in `EnvVault` (moved to `integration_common`), `syncUserEnv` (sensitive/encrypted, delete-then-create on a flipped flag), `userEnvHash` + `managedUserEnvKeys` (migration `202611040002_user_env`, applied); `envHash`/`keysToDelete` moved to `integration_common` |
> | 7. Pre-flight | ✅ | `envFor(component)`, system keys, scope in messages, `env-reserved:<id>` |
> | 8. Frontend | ✅ | `components/EnvEditor.tsx`, Configure (shared panel + per card), project page badge, `/deploy/new` uses `parseDotenv` |
> | 9. Docs | ✅ | README "Environment variables", `API_CONTRACT.md`, service READMEs, `PLAN.md` |
>
> **Verification so far:**
> - typecheck and tests pass in every package: backend 366 (was 335), `integration_common` 42 (37),
>   `vercel_integration` 97 (88), `render_integration` 96, `neondb_integration` 66, frontend 9 (6);
> - lint is clean for backend and frontend; `next build` passes for both;
> - a read-only database check shows the `EnvVar` table and all four indexes.
>
> **Not yet run:** the manual checks below, which need the running stack and a Vercel/Render deploy.
>
> **Deviations from the plan:**
> - `EnvironmentView.components` is an array (ordered frontend → backend → database), not a record.
> - The partial unique index is the backstop for shared keys. Writes compare against loaded rows
>   instead of upserting.
> - Vercel's `managedUserEnvKeys` stores `{ key, secret }`, so a flipped secret flag is re-created:
>   the docs say a Secret cannot become Config in place.
> - Every user value, not only secrets, is scrubbed from the Vercel build log that is relayed.
> - Old `Project.envVars` are kept in the column as `{}` (not dropped), as planned.
> - The reveal route `…/env/:key` cannot reveal a key literally named `suggestions`, because the
>   static route wins. It can still be set.
> - A note for the next migration: `prisma migrate diff` from the live database will propose
>   `DROP INDEX "EnvVar_shared_key"`. Remove that line by hand.

## Context

PLAN.md Phase 9 is 🟡.

**What exists today:**
- `Project.envVars` is **one plain JSON object per project** (`backend/prisma/schema.prisma`).
- It is set only from the textarea on `/deploy/new` (`frontend/app/(dashboard)/deploy/new/page.tsx`),
  and nothing can edit it afterwards.
- The API returns keys only (`ProjectsService.toView` → `envKeys`).

**Where the values go today:**
- To local Docker as runtime env (`lib/deployments/deploy-executor.service.ts:102,243`).
- To every Render backend (`projectEnvVars()` → `renderEnv()` in
  `lib/providers/provider-deployments.service.ts`), with Neon's `DATABASE_URL` and
  `DATABASE_URL_UNPOOLED` merged on top.
- **Never to Vercel.** A Vercel frontend gets only the backend's URL (`vercelPublicEnv()`, Phase 8).

**Where pre-flight's `env:<id>` check reads from:** the same project-wide set (`filledEnvKeys` in
`ComponentsService.preflight`). It compares it with `<rootDir>/.env.example` (`envExampleKeys`,
`envCheck` in `lib/components/preflight.ts`).

**The problems:**
- Values are unencrypted at rest.
- There is no secret/non-secret distinction.
- There is no editor.
- A frontend cannot be given its own vars.
- A backend's database password would go to every component if Vercel ever got the project set.

**Done when:**
1. On `/deploy/<id>/configure`, each component card has an **Environment** editor, and there is a
   **Shared** section, which goes to every backend and to local Docker.
2. The editor handles:
   - adding, editing and deleting rows;
   - pasting a `.env`;
   - "Add from .env.example";
   - a secret toggle;
   - reveal-on-click for non-secret values only. Secrets are write-only.
3. Values are AES-256-GCM sealed in a new `EnvVar` table.
4. On the next deploy:
   - a Render backend gets shared + its own vars + Neon's;
   - a Vercel frontend gets its own vars, with secrets as Vercel **sensitive** vars, plus the API URL;
   - local Docker gets the shared vars.
5. A saved change marks the component **"Env changed — redeploy to apply"**, with a **Save &
   redeploy** button.
6. Pre-flight counts a component's own, shared and system-provided keys.
7. No value appears in any API list response, log line, error message or log file.

### Decisions made with the user (2026-11-03)
1. **Per component, plus shared.**
   - Each `EnvVar` row belongs to one component, or to the whole project when `componentId` is
     null ("shared").
   - Shared vars go to every **backend** (Render) and to **local Docker** deploys. They do not go
     to frontends or databases.
   - A component's own value beats a shared one with the same key.
   - Existing `Project.envVars` become shared rows, so current projects behave exactly as before.
2. **Apply on next deploy.**
   - Saving touches only OrbitOps.
   - The component shows a "redeploy to apply" badge.
   - Vars go to the provider before each deploy, as Render's do today, so there is no new "sync
     now" endpoint in either service.
   - A change can never half-apply to a running app.

### Further design choices in this plan (recommended defaults; change before executing if needed)
- **Every value is sealed, secret or not**, with the backend's existing `lib/crypto/secret-box.ts`
  (`seal`/`open`, `ENCRYPTION_KEY`). `isSecret` only controls:
  - whether the value can ever be read back (reveal);
  - the Vercel var type: `sensitive` for secrets, `encrypted` otherwise.
- **New rows default to secret.** The Paste-a-`.env` and `.env.example` imports guess the flag from
  the key:
  - names containing `SECRET`, `TOKEN`, `KEY`, `PASSWORD`, `PRIVATE`, `CREDENTIAL`,
    `DATABASE_URL` or `DSN` → secret;
  - everything else → not secret.
- **Public-prefix keys can't be secret.** On a frontend, a key starting with `NEXT_PUBLIC_`,
  `VITE_`, `REACT_APP_`, `PUBLIC_` or `NUXT_PUBLIC_` is inlined into browser code. Marking it
  secret is refused (400, with a message saying why).
- **Turning a secret into a non-secret needs the value re-entered.** Otherwise the reveal endpoint
  would hand out a value that was entered as write-only.
- **System vars are never stored** (Phase 8's rule, unchanged). They are shown read-only in the
  editor, computed by one shared function:
  - `DATABASE_URL` and `DATABASE_URL_UNPOOLED` on a backend when the project has a Neon database.
    **Neon wins** over a user value, with a log line, as in Phase 8.
  - The API URL key (e.g. `NEXT_PUBLIC_API_URL`) on a frontend when there is exactly one backend
    with a URL. **The user's value wins** here: this is the "several backends" escape hatch that
    Phase 8's log line already tells the user to use.
- **No `target (build|runtime|both)` column.** PLAN.md lists one, but it would not change anything:
  - Render and Vercel make every var available to both build and runtime;
  - local Docker is runtime-only by design: never `--build-arg`, because build args end up in
    `docker history`.

  This is recorded as a deviation from PLAN.md.
- **"Redeploy to apply" uses a revision counter, not a hash of values.**
  - Each change bumps `Component.envRevision`. A shared change bumps every backend.
  - Each deployment records the `envRevision` it was sent with.
  - The badge shows when the component's revision is newer than its last successful deployment's.
  - This needs no value-derived data at rest.
- **Limits:**
  - keys match `^[A-Za-z_][A-Za-z0-9_]*$` and are at most 255 characters;
  - values are at most 32 KB, and may be multi-line (e.g. PEM keys);
  - at most 100 vars per scope;
  - keys the platform sets are refused: on Vercel `VERCEL_*`, `NOW_*` and Vercel's reserved
    list; on Render `RENDER_*`. Both lists are confirmed against the provider docs in step 0.

---

## Steps

### 0. Docs check (½ hour, no API key needed)
Confirm these against Vercel's and Render's docs, and record the answers at the top of
`lib/env/env-rules.ts`:
- **Vercel's `sensitive` type:**
  - Is it allowed for `production` and `preview`, and refused for `development`?
  - Can it be read back with `GET /v9/projects/:id/env`? Expected: no.
  - Upsert behaviour: `POST /v10/projects/:id/env?upsert=true` with an array.
- **Vercel's reserved env var names**, and the size limit per var and per deployment (64 KB total).
- **Render:** the reserved prefixes, and the value size limit.

### 1. Schema + migration — `backend/prisma/schema.prisma`, migration `202611040001_env_vars`
```prisma
/// One environment variable. componentId NULL = shared: sent to every backend
/// and to local Docker. Values are sealed with lib/crypto/secret-box, whether
/// secret or not; isSecret only decides if the value can ever be read back.
model EnvVar {
  id          String   @id @default(cuid())
  projectId   String
  componentId String?
  key         String   @db.VarChar(255)
  valueEnc    String   @db.Text
  isSecret    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  project   Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  component Component? @relation(fields: [componentId], references: [id], onDelete: Cascade)

  @@unique([projectId, componentId, key])
  @@index([projectId])
}
// Project:    env EnvVar[]          (the old envVars Json column stays, unused, until Phase 10; see step 2)
// Component:  env EnvVar[]
//             envRevision Int @default(0)
// Deployment: envRevision Int?      (what the deploy was sent with; NULL = before Phase 9)
```
- **Shared keys need a partial index.** Postgres treats NULLs as distinct, so `@@unique` does not
  stop two shared rows with the same key. The migration SQL adds
  `CREATE UNIQUE INDEX "EnvVar_shared_key" ON "EnvVar"("projectId","key") WHERE "componentId" IS NULL;`
  by hand. Prisma can't express a partial index, so a comment in `schema.prisma` points at the
  migration.
- The migration is generated with `prisma migrate diff` (as in Phases 6–8), the partial index is
  appended, and it is applied with `migrate deploy`.

### 2. Moving the existing `Project.envVars` across (in code, at startup)
SQL can't seal values, because the key is in the app. So the move runs in code:
- `EnvVarsService.migrateLegacy()` is called from `lib/runtime.ts`'s bootstrap, before
  `reconcile()`.
- For each project whose `envVars` is non-empty and which has no shared `EnvVar` rows:
  1. seal each value;
  2. insert it as a shared row with `isSecret: true`, the safe default, since we don't know;
  3. set `envVars = {}`.

  All three happen in one transaction.
- It is idempotent, and logs `[env] Moved N env vars of <project> into EnvVar (keys: A, B)`.
- `ProjectsService.create` stops writing the JSON column. `dto.envVars` from `/deploy/new` becomes
  shared rows through `EnvVarsService.putShared`, in the same transaction.
- The column is kept, with a `/// Deprecated (Phase 9): moved to EnvVar; always {}` comment, so
  rolling back the code doesn't lose data. Dropping it is a later cleanup.

### 3. `lib/env/` — the service and pure helpers, each with unit tests
- **`env-rules.ts`** (pure):
  - `ENV_KEY` and `MAX_VALUE_BYTES`;
  - `looksSecret(key)` and `isPublicPrefix(key, framework)`;
  - `reservedFor(provider)`: the step-0 lists;
  - `validateEnvList(list, { provider, kind, framework })` → a `badRequest` naming the key, never
    the value.
- **`env-input.ts`**: `parseEnvPut(body)` → `{ vars: Array<{ key, value?: string, isSecret }> }`.
  - `value` omitted means keep the current value; a new key without one → 400.
  - Duplicate keys are refused, and so is a body over 100 entries.
- **`env-file.ts`** (pure, shared with the frontend through a copy in `frontend/lib/deploy/`):
  `parseDotenv(text)`. It handles:
  - `KEY=value`, `export KEY=`;
  - single- and double-quoted values, with `\n` escapes in double quotes;
  - `#` comments.

  It returns `{ entries, skipped: [{ line, reason }] }`. It replaces the `parseEnv` in
  `deploy/new/page.tsx`.
- **`system-env.ts`**: `systemEnvKeys(component, siblings)` →
  `Array<{ key, source: "neon" | "backend", from: componentName }>`.
  - These are the keys only, the single source used by the editor, pre-flight and the deploy
    path.
  - `renderEnv` and `vercelPublicEnv` in `provider-deployments.service.ts` are refactored to call
    it for the keys. The values are still fetched there, as now.
- **`env-vars.service.ts`**, `EnvVarsService(prisma, events)`:
  - **`list(userId, projectId)`** → `EnvironmentView`:
    `{ shared: EnvVarView[], components: Record<componentId, { vars, system, pendingRedeploy, revision }> }`.
    - `EnvVarView = { key, isSecret, updatedAt }`, which has **no value**.
    - `pendingRedeploy` = `envRevision >` the `envRevision` of the component's latest `success`
      deployment, and only for components that have been deployed once.
  - **`put(userId, projectId, componentId | null, dto)`**: one transaction:
    1. load the current rows;
    2. validate against the component's provider, kind and framework. For shared rows, use the
       backends' rules: Render plus local Docker;
    3. delete the keys that are gone, update the changed ones (re-sealing only when a value was
       sent), and create the new ones;
    4. turning a secret into a non-secret without a value → 400 `env_value_required`;
    5. bump `envRevision` on the component, or on every backend component for a shared change;
    6. emit `projectChanged(projectId, "updated")`;
    7. log `[env] <user> saved <scope>: +A ~B -C` (keys only).

    Returns the new view.
  - **`reveal(userId, projectId, componentId | null, key)`** → `{ key, value }` for a non-secret
    row only. A secret → 403 `env_secret` ("Secret values can't be shown; enter a new value to
    replace it."). The response is `cache-control: no-store`.
  - **`suggestions(userId, projectId, componentId)`**:
    - reads `<rootDir>/.env.example` at the branch head, reusing `ComponentsService`'s
      `openRepo`/`getFileContent` path and `envExampleKeys` from `preflight.ts`;
    - returns `Array<{ key, example: string | null, looksSecret, alreadySet, providedBySystem }>`;
    - `example` is the value from the file, only when `looksSecret` is false. Placeholders in an
      example file are not secrets, but we still don't echo them for secret-looking keys.
  - **`resolve(projectId, component | null)`** is internal, for deploys. It returns
    `{ vars: EnvVar[], secrets: string[], revision }`:
    - a backend gets shared overlaid with its own rows;
    - a frontend gets its own rows;
    - `null`, meaning local Docker, gets the shared rows;
    - a database gets nothing.

    `secrets` is the values of the `isSecret` rows, for log redaction.
  - **`filledKeys(projectId, component)`**, for pre-flight: the keys with non-empty values, by the
    same scope rules.
- **Wiring:** `lib/runtime.ts` builds `envVars` and passes it to `ProjectsService`,
  `ComponentsService`, `ProviderDeploymentsService` and `DeployExecutorService`.

### 4. Routes — `backend/app/api/projects/[projectId]/…`
Each route follows the existing pattern: `requireUser`, `services()`, `toErrorResponse`, and
`runtime = "nodejs"`.

| Method & path | Purpose |
|---|---|
| `GET /env` | `EnvironmentView`: every scope, keys and flags only |
| `PUT /env` | replace the **shared** set → `EnvironmentView` |
| `GET /env/:key` | reveal a non-secret shared value (`no-store`) |
| `PUT /components/:componentId/env` | replace a component's set → `EnvironmentView` |
| `GET /components/:componentId/env/:key` | reveal a non-secret component value (`no-store`) |
| `GET /components/:componentId/env/suggestions` | keys from `<rootDir>/.env.example` |

- A database component → 400 ("A database has no env vars; its connection string goes to the
  backend").
- A wrong user → 404 everywhere, as in the rest of the API.
- `ProjectView.envKeys` stays: the shared keys, read through the relation. The project page keeps
  working until step 7 replaces it.

### 5. Deploy paths — the values reach the providers
- **`ProviderLogSink`** (`lib/providers/provider-log-sink.ts`) gains
  `addSecrets(deploymentId, values)`. It is passed through to `DeploymentLogWriter.addSecret`, so
  any line we write is scrubbed. This is a backstop: we never write values on purpose.
- **Render backend**, in `renderEnv()`:
  - `projectEnvVars(project)` is replaced by `envVars.resolve(project.id, component)`;
  - the Neon merge stays as it is;
  - `addSecrets(deployment.id, resolved.secrets)` is called, plus both connection strings, which
    is new: today they are only kept out of logs by never being written;
  - `Deployment.envRevision = resolved.revision` is stored.
  - **The Render service needs no change.** It already takes `envVars`, holds them only in its
    `EnvVault`, redacts them from relayed logs, hash-skips unchanged sets and deletes stale managed
    keys.
- **Vercel frontend** (backend side):
  - `startDeployment` sends a new `envVars: Array<{ key, value, secret }>` from `resolve()`;
  - a user key equal to the system API URL key is dropped from `publicEnvVars`, because the user
    wins (see the design choices);
  - `envRevision` is stored, and `addSecrets` called, as for Render;
  - `lib/providers/vercel-service.types.ts` gains the field.
- **Local Docker** (`deploy-executor.service.ts:102,243`):
  - `project.envVars` is replaced by `envVars.resolve(project.id, null)`;
  - its `secrets` go to `logs.open(projectId, deploymentId, secrets)`, which already takes a
    secrets list;
  - it is still runtime env only, never `--build-arg`.
- **`projectEnvVars()`** loses its last caller. It is deleted, and its test cases move to
  `env-vars.service.test.ts`.

### 6. `vercel_integration`: user env vars (secret-safe, like Render's)
- **Move `EnvVault` to `integration_common`:**
  - `render_integration/src/deployments/env-vault.ts` becomes
    `integration_common/src/env-vault.ts`, with its test, and is exported as
    `@orbitops/integration-common/env-vault`;
  - Render's copy is renamed `xxx_env-vault.ts` (the mark-don't-delete rule) and Render imports the
    shared one;
  - `tsconfig` and vitest already exclude `**/xxx*`.
- **`types.ts`:**
  - `DeployRequest.envVars?: Array<EnvVar & { secret: boolean }>` is **never stored**;
  - `StoredDeployInput` gains `envKeys: string[]`, mirroring Render;
  - `VercelProject` gains `userEnvHash String? @db.VarChar(64)` and
    `managedUserEnvKeys Json @default("[]")`, in migration `202611040002_user_env`.
- **`deploy-input.ts`: `parseEnvVars`:**
  - at most 100 entries, the key regex, `secret` a boolean;
  - values are strings of at most 32 KB, and multi-line is allowed;
  - reserved keys are refused;
  - a key also in `publicEnvVars` → 400. The backend never sends one, because it drops the clash.
- **`deployments.service.ts`:** `vault.put(deploymentId, envVars)`; only the keys are stored.
- **`deploy-runner.ts`**, after `syncPublicEnv` and before `deploy`:
  1. Take the vars from the vault.
  2. **If the stored `envKeys` is non-empty but the vault is empty** (a restart before this point),
     fail with `vercel_interrupted`: "This deploy was interrupted before it reached Vercel, and its
     env vars are no longer held. Deploy again." This is Render's rule.
  3. Add every value to the run's redaction list, so the build logs relayed back are scrubbed, as
     in Render's runner.
  4. If `envHash(vars)` (the shared hash helper, see below) ≠ `userEnvHash`:
     - upsert through the existing `provider.setEnv`, as `sensitive` (secret) or `encrypted`, with
       `target: ["production", "preview"]`;
     - delete `managedUserEnvKeys` that are gone, through the list-then-`DELETE` code that
       `syncPublicEnv` already has, extracted to `removeEnvKeys(ctx, projectId, keys)`;
     - store the hash and the keys.
  5. Log `Set N environment variables on the Vercel project (keys: A, B)`.
  - Vars added by hand on Vercel's dashboard are never touched: only managed keys are deleted.
- **`envHash` and `keysToDelete`** from `render_integration/src/render/env-vars.ts` move to
  `integration_common/src/env-hash.ts`. Render's `toEnvVars` stays in Render and imports them, and
  Vercel's `public-env.ts` `publicEnvHash` becomes a re-export.
- **Tests:**
  - the vault is taken once;
  - interrupted + keys → `vercel_interrupted`;
  - interrupted + no keys → resumes as today;
  - the hash skip;
  - stale-key delete;
  - the `sensitive` vs `encrypted` type;
  - reserved and duplicate keys refused;
  - a value never appears in a log line or error, checked by searching the emitted batches for the
    value.

### 7. Pre-flight — `lib/components/preflight.ts`, `components.service.ts`
- `PreflightProject.filledEnvKeys: string[]` becomes `filledKeysFor(component): Set<string>`. It is
  built in `ComponentsService.preflight` from `envVars.filledKeys` plus `systemEnvKeys`, so:
  - a frontend's `.env.example` asking for `NEXT_PUBLIC_API_URL` passes when a backend will
    provide it;
  - a backend's `DATABASE_URL` passes when a Neon database exists.

  This replaces `PROVIDED_BY_DATABASE`.
- The `envCheck` failure message names the scope: "web: frontend/.env.example needs STRIPE_KEY,
  which has no value. Add it under web → Environment."
- **New check `env-reserved:<id>`:** a stored key that the component's provider reserves → fail.
  This catches rows that were valid when saved as shared but are reserved for a backend added
  later.
- `deployable` and `ok` are unchanged.

### 8. Frontend
- **`lib/deploy/types.ts`:** `EnvVarView`, `EnvironmentView`, `EnvSuggestion`, and
  `SystemEnvView = { key, source, from }`.
- **`lib/deploy/client.ts`:** `getEnvironment`, `putSharedEnv`, `putComponentEnv`, `revealEnv`,
  `envSuggestions`.
- **New `components/EnvEditor.tsx`**, one instance per scope:
  - **Rows:** key input, a value input, a 🔒 secret toggle, delete.
    - A saved secret shows `•••••• (set)` and a **Replace** button; a value is never fetched.
    - A saved non-secret shows `••••••` and a **Show** button, which calls `revealEnv`. The value is
      held in component state only and is not cached.
  - **System rows**, read-only and greyed: "`DATABASE_URL` · from Neon database db", "`NEXT_PUBLIC_API_URL`
    · from backend api", with a hover explaining override rules.
  - **Paste .env:** a textarea, then `parseDotenv`, then a preview of the rows to be added, with
    the skipped lines listed and secrets guessed by `looksSecret`.
  - **Add from .env.example:** lists `suggestions` not yet set, each with Add; example values are
    pre-filled for non-secret keys.
  - **Inline validation** that mirrors the backend: the key regex, duplicates, public prefix +
    secret, reserved keys. The backend stays authoritative.
  - **Buttons:** **Save**, plus **Save & redeploy** when the component has a provider resource. It
    calls `putComponentEnv`, then `deployComponent`.
  - Leaving with unsaved edits asks for confirmation.
  - Values are cleared from state after a successful save.
- **`configure/page.tsx`:**
  - an **Environment** section on each frontend and backend card, collapsed by default and showing
    the count;
  - a **Shared env vars** panel above the cards: "sent to every backend and to Docker builds";
  - database cards say "No env vars: the backend receives `DATABASE_URL`".
- **`deploy/[projectId]/page.tsx`:**
  - the `envKeys.join(", ")` line is replaced with a per-component "N env vars";
  - an amber **Env changed — redeploy to apply** badge with a Redeploy button when
    `pendingRedeploy`;
  - a link to Configure → Environment.
- **`deploy/new/page.tsx`:**
  - the textarea is labelled "Shared env vars (stored encrypted, as secrets)";
  - its parser is replaced by `parseDotenv`, with skipped lines shown.

### 9. Docs
- **README:**
  - an **Environment variables** section: scopes, secret vs non-secret, system vars and who wins,
    "apply on next deploy", what each provider receives (Render: all as normal vars; Vercel:
    `sensitive`/`encrypted`; Docker: runtime only), and the limits and reserved keys;
  - the test counts.
- **`frontend/docs/API_CONTRACT.md`:**
  - the six routes, `EnvironmentView`, `EnvVarView` and `EnvSuggestion`;
  - the errors: `env_secret`, `env_value_required`, `bad_request` for an invalid, reserved or
    public-secret key, and `vercel_interrupted`;
  - `pendingRedeploy`.
- **`backend/vercel_integration/README.md`:** the `envVars` field and the vault, and the restart
  rule.
- **`backend/integration_common/README.md`:** `env-vault` and `env-hash`.
- **`PLAN.md`:**
  - the Phase 9 checklist goes ✅;
  - the `target` deviation is noted;
  - the status table, and the Cross-cutting entry "encrypted env vars ✅".
- **`PLAN_PHASE_9.md`:** a status header like Phase 8's.

---

## Out of scope
- Pushing vars to the provider on save without a deploy (decided: apply on next deploy).
- Per-environment values (production vs preview), and Vercel's `development` target.
- Importing existing vars **from** Render or Vercel into OrbitOps.
- Env var history and audit trail beyond the keys-only log line; rollback of env.
- Rotating `ENCRYPTION_KEY` (the `v1.` prefix makes it possible later).
- Dropping the old `Project.envVars` column.
- Secret scanning of the repository's committed `.env` files.
- Injecting the frontend URL into the backend as `CORS_ORIGIN`. The user sets it as a normal
  backend var, and the README shows how.

## Verification
1. **Build hygiene:**
   - `integration_common`, `vercel_integration`, `render_integration` and `neondb_integration`:
     `npx tsc --noEmit && npm test`;
   - `backend` and `frontend`: `npm run typecheck && npm run lint && npm test`;
   - `prisma validate` on both changed schemas;
   - `next build` for both apps, then `git checkout -- backend/next-env.d.ts` if it gets rewritten.
2. **Unit tests** (Vitest):
   - **env-rules:** key regex, `looksSecret`, public prefix + secret, reserved per provider.
   - **parseDotenv:** quotes, `export`, escapes, comments, skipped lines.
   - **EnvVarsService** (fake Prisma):
     - put: add, update, keep-value-when-omitted, delete;
     - secret → non-secret needs a value;
     - revision bump, including a shared change bumping every backend;
     - list never contains a value;
     - reveal refuses secrets;
     - scope resolution: backend = shared + own with own winning, frontend own only, Docker shared,
       database nothing;
     - `migrateLegacy` is idempotent, seals values, and empties the column;
     - `filledKeys`.
   - **Routes:** 404 for another user; 400 for a database component; `no-store` on reveal.
   - **Pre-flight:**
     - a frontend `NEXT_PUBLIC_API_URL` is satisfied by one backend;
     - a backend `DATABASE_URL` is satisfied by Neon;
     - the scope named in the message;
     - `env-reserved`.
   - **provider-deployments:**
     - Render gets the resolved vars plus Neon's, with Neon winning;
     - Vercel gets `envVars`, and a user API URL key suppresses the system one;
     - `envRevision` is stored;
     - `addSecrets` is called with every secret and both connection strings.
   - **deploy-executor:** Docker gets the shared vars, and the log writer gets the secrets.
   - **vercel_integration:** as listed in step 6.
   - **integration_common:** the `env-vault` and `env-hash` tests moved from Render.

   Combined counts must be ≥ today's (backend 335, common 37, vercel 88, render 96, neondb 66,
   frontend 6), with nothing skipped.
3. **Manual**, with `Robert-547/Vercel_Integration_test`:
   - **Migration:** restart the backend, and the existing project's vars appear under **Shared**
     as secrets. In the database, the `Project.envVars` column is `{}`, and `"EnvVar"."valueEnc"`
     starts `v1.`.
   - **Editor:**
     - add a non-secret `GREETING=hi` to the backend and a secret `API_SECRET` to it;
     - Show reveals `hi`; the secret has no Show;
     - `GET /api/projects/:id/env` contains neither value (check in devtools);
     - marking `NEXT_PUBLIC_X` secret on the frontend is refused.
   - **Imports:** Paste `.env` with quotes and comments imports the right rows. Add from
     `.env.example` lists the missing keys.
   - **Redeploy badge:** saving shows "Env changed — redeploy to apply". Save & redeploy deploys
     the backend, and the badge clears when it goes live.
   - **Render:**
     - the dashboard shows `GREETING`, `API_SECRET` and `DATABASE_URL`;
     - a backend route that returns `process.env.GREETING` answers `hi`;
     - a second deploy without changes makes no env calls (log).
   - **Vercel:**
     - give the frontend `NEXT_PUBLIC_GREETING=hello` and a secret `SERVER_ONLY_TOKEN`;
     - Deploy all; on Vercel's dashboard the first is *Encrypted* and the second *Sensitive*,
       which can't be revealed;
     - the page renders `hello`;
     - the backend's URL is still set automatically;
     - setting `NEXT_PUBLIC_API_URL` yourself makes your value win, as the log says.
   - **Removal:** delete `GREETING` and redeploy, and it is gone from Render. A var added by hand
     on Render's dashboard is untouched.
   - **Leak checks:**
     - `grep -r` for each test value in `backend/data/logs` and in each service's console output
       finds nothing;
     - an error case (a bad key) names the key and never the value.
   - **Restart rule:** stop `vercel_integration` while a Vercel deploy is queued and start it again.
     The run fails with "deploy again" if it carried vars, and resumes if it didn't.
   - **Local Docker:** a Docker deploy of a project with shared vars starts its container with
     them, as before.
   - **Second user:** every env route → 404.
   - **Regression:** Deploy all (Phase 8), push-to-deploy, and Render-only and Vercel-only
     deploys all still work.
