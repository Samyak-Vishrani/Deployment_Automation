# Phase 5 — Deployment Configuration: implementation plan


## Context

Phase 5 of `PLAN.md` ("the user confirms where each component goes") is the bridge between
repository analysis (Phase 4) and the provider integrations (Phases 6–8). Vercel/Render cannot be
built until there is a stored, user-confirmed **deployable component** per folder carrying
`kind`, `rootDir`, build/start/output settings and a `provider`. Today:

- `ProjectComponent` (`backend/prisma/schema.prisma`) holds detection output only, and belongs to
  an `Analysis` snapshot. Every run writes a new snapshot and old ones are pruned (the last 5 are
  kept) — so it cannot also hold provider ids or user edits.
- ✅ Done in Phase 4 (`PLAN_PHASE_4_Remaining.md`): detection now produces `role`, `installCmd`,
  `buildCmd`, `startCmd`, `outputDir`, `runtimeVersion` and `evidence` per component, plus a
  database hint on the snapshot; analysis authenticates with the GitHub App installation token and
  reads the project's `branch` at a pinned commit.
- The frontend shows the analysis read-only (`frontend/components/AnalysisPanel.tsx`) but has no
  configuration UI; `/projects/*` pages run on the mock provider, only `/deploy/*` talks to the
  real backend.

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
Add enums and model; new migration, timestamped after `202609300001_analysis_snapshot` (Phase 4):

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

### 2. Analysis auth + branch — ✅ done in Phase 4
See `PLAN_PHASE_4_Remaining.md` step 1. `AnalysisService` (`backend/lib/analysis/analysis.service.ts`)
is registered as `services().analysis`, uses the installation token, reads
`project.branch ?? project.defaultBranch` and pins the run to that branch's head SHA. Nothing to do here.

### 3. Build-settings derivation — ✅ done in Phase 4
See `PLAN_PHASE_4_Remaining.md` step 6. `backend/lib/analysis/build-settings.ts` runs during
detection, so every `ProjectComponent` already carries `role`, `installCmd`, `buildCmd`, `startCmd`,
`outputDir` and `runtimeVersion`. This phase only maps them onto a proposed `Component`:

- `kind` ← `role` (`frontend` / `backend`; `unknown` is shown for the user to pick)
- `rootDir` ← `path`, `nodeVersion` ← `runtimeVersion`, the commands and `outputDir` as detected
- `name` ← the last segment of `path`, or the repo name for the root

The configure screen (step 7) is where the user overrides any of it.

### 4. Component service + validation
- `backend/lib/components/component-input.ts` — hand-written validators in the style of
  `backend/lib/projects/project-input.ts` (unknown-key rejection, max lengths). Rules: `rootDir`
  relative, no `..`, no leading `/`; `provider` must equal `PROVIDER_FOR_KIND[kind]` in the MVP;
  at most one `database` component; command strings ≤ 500 chars, single line.
- `backend/lib/components/components.service.ts` (class, added to `Runtime`):
  - `fromAnalysis(userId, projectId)` → maps the latest `Analysis` snapshot's `ProjectComponent` rows
    (step 3) into **proposed** components (not saved) for the UI to edit; when its `database` hint
    has `suggestNeon`, proposes a `database` component too.
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

The `analyze`/`analysis` routes already use `requireUser` + `toErrorResponse` (Phase 4).

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
Dockerfile generation (post-MVP `local-docker`).

## Verification
1. `cd backend && npx prisma migrate dev` applies cleanly; `npm run typecheck && npm run lint && npm test`.
2. New vitest suites: `component-input.test.ts` (provider/kind rule, `..` rejection, unknown keys),
   `preflight.test.ts` (fake tree/fetcher), `components.service.test.ts` (replaceAll keeps
   `providerResourceId`, proposal built from the latest snapshot).
3. Manual, with backend + frontend running and a test repo containing `frontend/` (Next.js) and
   `backend/` (Express/Nest):
   - `/deploy/new` → connect → lands on Configure with two cards: frontend→Vercel (`frontend`,
     `npm run build`, `.next`), backend→Render (`backend`, start cmd).
   - Edit a command, Save, reload → edits persist; re-run analysis → edits and ids still there.
   - Pre-flight: root dirs pass, credential checks show "pending", Deploy disabled.
   - Set rootDir to `../x` → 400 with a clear message.
   - Second user cannot `GET /api/projects/<id>/components` (404).
   - Existing push-to-deploy on the Docker test repo still works.

