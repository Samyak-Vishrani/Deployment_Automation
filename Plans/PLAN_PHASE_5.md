# Phase 5 — Deployment Configuration: implementation plan


## Context

Phase 5 of `PLAN.md` ("the user confirms where each component goes") is the bridge between
repository analysis (Phase 4) and the provider integrations (Phases 6–8). Vercel/Render cannot be
built until there is a stored, user-confirmed **deployable component** per folder carrying
`kind`, `rootDir`, build/start/output settings and a `provider`. Today:

- `ProjectComponent` (`backend/prisma/schema.prisma:147`) only holds raw detection output
  (`type, framework, language, path, packageManager, detectedVersion, confidence`), and
  `analyzeProject` **deletes and recreates** those rows on every run
  (`backend/lib/analysis/analysis.service.ts:196`) — so it cannot also hold provider ids or user edits.
- Detection produces no `buildCmd` / `startCmd` / `outputDir` / role.
- **Blocking bug:** analysis authenticates with `GitHubConnection.accessToken`
  (`analysis.service.ts:105`), but GitHub OAuth sign-in deliberately never stores that token
  (`backend/lib/auth/github-oauth.ts` header comment). Every analysis currently fails with
  `github_not_connected`. It also reads `defaultBranch` instead of the project's `branch`.
- The frontend has no analysis or configuration UI; `/projects/*` pages run on the mock provider,
  only `/deploy/*` talks to the real backend.

**Outcome:** connect repo → analysis runs → user reviews/edits one card per component (Frontend →
Vercel, Backend → Render, optional Database → Neon) → saves → sees pre-flight results. The local
Docker deploy path keeps working untouched.

## Design decisions

1. **New `Component` model, keep `ProjectComponent` as the analysis snapshot.** Analysis output
   (re-generated, disposable) and deployment configuration (user-owned, holds provider resource
   ids) have different lifecycles. Re-running analysis must never wipe a `providerResourceId`.
2. **Provider rule lives in data + one constant.** `provider` is a stored enum; an MVP map
   `PROVIDER_FOR_KIND = { frontend: vercel, backend: render, database: neon }` is enforced by
   validation. Post-MVP = relax the validator + widen the dropdown, no migration.
3. **Keep the existing `POST /api/projects` (repo URL → project).** It already resolves
   `installationId`, `repoId` and branch, which analysis needs. Components are created in a second
   step from the analysis, instead of overloading project creation.
4. **Analysis uses the GitHub App installation token** (`GithubAppService.getInstallationToken`,
   `backend/lib/github/github-app.service.ts:152`), same as the deploy executor.
5. **Pre-flight = list of independent checks** returning `pass | fail | pending` with a message.
   The provider-credential check is a stub reporting "not connected" until Phase 6 adds
   `ProviderCredential`; the Deploy button stays disabled until all checks pass (i.e. until Phase 6).
6. **Docker fields stay on `Project`** for the `local-docker` path; no refactor of the executor.

## Steps

### 1. Schema + migration — `backend/prisma/schema.prisma`
Add enums and model; new migration `202609270001_deployment_configuration`:

```prisma
enum ComponentKind     { frontend backend database }
enum ProviderId        { vercel render neon local_docker }
enum ComponentStatus   { draft configured deploying live failed }

model Component {
  id                 String          @id @default(cuid())
  projectId          String
  kind               ComponentKind
  name               String                      // "web", "api"… shown on the card
  rootDir            String          @default(".")
  framework          String?
  buildCmd           String?
  startCmd           String?
  installCmd         String?
  outputDir          String?
  nodeVersion        String?
  provider           ProviderId
  providerResourceId String?                     // filled by Phase 6/7/8
  url                String?
  status             ComponentStatus @default(draft)
  analysisComponentId String?                    // which ProjectComponent it came from (nullable)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@unique([projectId, kind, rootDir])
  @@index([projectId])
}
```
Add `deployComponents Component[]` to `Project`. Run `npx prisma migrate dev --name deployment_configuration`.

### 2. Fix analysis auth + branch — `backend/lib/analysis/analysis.service.ts`
- Replace the `GitHubConnection.accessToken` lookup with the installation token: take
  `project.installationId` (or `github.resolveInstallationId` for old rows) → `getInstallationToken`.
  Inject `GithubAppService` (convert to a class registered in `backend/lib/runtime.ts`, or pass it
  in as a parameter from the route — prefer adding `analysis` to the `Runtime` graph).
- Use `project.branch ?? project.defaultBranch ?? "main"`.
- Register the token with nothing that logs; keep the existing "no token in JSON" test.
- Update `analysis.service.test.ts` mocks accordingly.

### 3. Build-settings derivation — new `backend/lib/analysis/build-settings.ts` (pure)
`deriveBuildSettings(detected: DetectedComponent, files: { lockfiles: string[]; pkg?: PackageJson }) → { kind, name, buildCmd, startCmd, installCmd, outputDir, nodeVersion }`

- `kind`: `web`/`static` → frontend; `api`/`worker` → backend; `docker` → backend.
- Package manager from lockfiles in the tree (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`)
  → install/run prefix. `nodeVersion` from `package.json` `engines.node`.
- Prefer the repo's own `scripts.build` / `scripts.start` when present; else framework defaults:
  | framework | build | start | output |
  |---|---|---|---|
  | nextjs | `<pm> run build` | `<pm> start` | `.next` |
  | react (vite) / vue / angular | `<pm> run build` | — | `dist` (CRA: `build`) |
  | express / fastify / node | — or `<pm> run build` if script | `<pm> start` / `node <main>` | — |
  | nestjs | `<pm> run build` | `node dist/main` | — |
  | fastapi | `pip install -r requirements.txt` | `uvicorn main:app --host 0.0.0.0 --port $PORT` | — |
  | django / flask | same install | `gunicorn <module>.wsgi` / `gunicorn app:app` | — |
- Small detection gap to close while here (`detection.service.ts`): recognise `vite` and
  `react-scripts` so the output dir is right, and pass `package.json` scripts/engines through.

### 4. Component service + validation
- `backend/lib/components/component-input.ts` — hand-written validators in the style of
  `backend/lib/projects/project-input.ts` (unknown-key rejection, max lengths). Rules: `rootDir`
  relative, no `..`, no leading `/`; `provider` must equal `PROVIDER_FOR_KIND[kind]` in the MVP;
  at most one `database` component; command strings ≤ 500 chars, single line.
- `backend/lib/components/components.service.ts` (class, added to `Runtime`):
  - `fromAnalysis(userId, projectId)` → maps current `ProjectComponent` rows through
    `deriveBuildSettings` into **proposed** components (not saved) for the UI to edit.
  - `list`, `replaceAll(userId, projectId, inputs)` (transaction; upsert on
    `(projectId, kind, rootDir)` so existing `providerResourceId`/`url` survive, delete the rest),
    `update`, `remove`. Ownership via the same "404 for not-yours" rule as
    `ProjectsService.getOrThrow`. Emit `events.projectChanged(id, "updated")`.
- `backend/lib/components/provider-rules.ts` — `PROVIDER_FOR_KIND`, labels.

### 5. Pre-flight — `backend/lib/components/preflight.ts`
`runPreflight(project, components, deps) → { ok: boolean; checks: Check[] }`, each check
`{ id, componentId?, status: "pass"|"fail"|"pending", message }`:
- **root dir exists** — one `getRepositoryTree` call (installation token), check each `rootDir`
  is a `tree` entry (or `.`).
- **required env vars** — read `<rootDir>/.env.example` if present; keys missing from
  `project.envVars` → fail listing the key names (never values).
- **provider credential** — injected `hasCredential(userId, provider)`; Phase 5 stub returns
  `pending: "Connect <Vercel|Render|Neon> in Settings (available in Phase 6)"`.
- **at least one component** configured.

### 6. API routes (Next.js route handlers, pattern of `backend/app/api/projects/[projectId]/route.ts`: `requireUser` → service → `toErrorResponse`)
| Method & path | Purpose |
|---|---|
| `GET  /api/projects/:id/components` | saved components |
| `GET  /api/projects/:id/components/proposal` | analysis → proposed components (runs analysis if none yet) |
| `PUT  /api/projects/:id/components` | save the confirmed set (sets status `configured`) |
| `PATCH/DELETE /api/projects/:id/components/:cid` | edit / remove one |
| `GET  /api/projects/:id/preflight` | pre-flight result |

Also switch `analyze`/`analysis` routes to `requireUser` + `toErrorResponse` for consistency.

### 7. Frontend — real-backend pages under `/deploy`
- `frontend/lib/deploy/types.ts` + `client.ts`: `DeployComponent`, `PreflightResult`, and
  `getComponentProposal`, `listComponents`, `saveComponents`, `getPreflight` (same `withSession` pattern).
- New `frontend/app/(dashboard)/deploy/[projectId]/configure/page.tsx`:
  - Loads saved components, else the proposal. One card per component:
    kind badge, name, `rootDir`, framework, install/build/start/output fields, provider `<select>`
    with the single allowed option (disabled), remove button.
  - "Add database (Neon)" toggle → adds a `database` card (no commands).
  - Save → `PUT`; then shows the pre-flight panel (pass/fail/pending list).
  - **Deploy** button disabled with tooltip "Provider deploys arrive in Phase 6" unless `preflight.ok`.
- `deploy/new/page.tsx`: after create, route to `/deploy/<id>/configure` instead of the project page.
- `deploy/[projectId]/page.tsx`: add a "Components" summary + "Configure" link. Existing local
  Docker Deploy/Rollback buttons unchanged.
- Reuse existing UI primitives (`components/ui/*`, `form-grid`, `field-label`, `panel` classes from `deploy/new/page.tsx`).

### 8. Docs
- Update `PLAN.md` Phase 5 checkboxes; note the analysis auth fix under Phase 4.
- `frontend/docs/API_CONTRACT.md`: add the component + preflight endpoints.

## Out of scope (belongs to later phases)
Provider API calls and `ProviderCredential` storage (6–8), encrypted per-component env vars (9),
DB-usage auto-detection → Neon suggestion (Phase 4 leftover), Dockerfile generation (post-MVP
`local-docker`).

## Verification
1. `cd backend && npx prisma migrate dev` applies cleanly; `npm run typecheck && npm run lint && npm test`.
2. New vitest suites: `build-settings.test.ts` (fixture package.json/lockfile combos per framework),
   `component-input.test.ts` (provider/kind rule, `..` rejection, unknown keys),
   `preflight.test.ts` (fake tree/fetcher), `components.service.test.ts` (replaceAll keeps
   `providerResourceId`), updated `analysis.service.test.ts` (installation token, project branch).
3. Manual, with backend + frontend running and a test repo containing `frontend/` (Next.js) and
   `backend/` (Express/Nest):
   - `/deploy/new` → connect → lands on Configure with two cards: frontend→Vercel (`frontend`,
     `npm run build`, `.next`), backend→Render (`backend`, start cmd).
   - Edit a command, Save, reload → edits persist; re-run analysis → edits and ids still there.
   - Pre-flight: root dirs pass, credential checks show "pending", Deploy disabled.
   - Set rootDir to `../x` → 400 with a clear message.
   - Second user cannot `GET /api/projects/<id>/components` (404).
   - Existing push-to-deploy on the Docker test repo still works.

