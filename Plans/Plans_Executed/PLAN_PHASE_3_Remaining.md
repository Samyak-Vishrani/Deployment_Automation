# Phase 3 — GitHub Integration: remaining work

> Companion to `PLAN_PHASE_4_Remaining.md` and `PLAN_PHASE_5.md`. Not started.

## Context

`PLAN.md` Phase 3 ("a user connects GitHub, sees their repositories and picks one") is 🟡. The
GitHub **App** side is built — App JWT, installation tokens, repo metadata, branch check, webhook
HMAC + dedupe — and the push-to-deploy pipeline and Phase 4's analysis both run on it. What is
missing is everything that involves the *user*:

- To connect a repo the user pastes a URL into `/deploy/new`. If the App is not installed on it they
  get "The GitHub App is not installed on …" and have to work out the install themselves.
- After installing, GitHub redirects to `http://localhost:4001/auth/github/callback` — a dead URL
  left on the App from the NestJS prototype.
- Sign-in (`backend/lib/auth/github-oauth.ts`) uses a separate OAuth App and throws the user's token
  away, so nothing in the backend can ask GitHub "what can *this* user access?".

**Done when** (`PLAN.md`): a new user signs in, installs the App once, and sees their repo list in the
dashboard; picking a repo and a branch connects it. Installing on more repos lands back in the app.

## Gaps to close

| # | Gap | Where | Effect |
|---|---|---|---|
| G1 | No repository list; connecting means pasting a URL | `frontend/app/(dashboard)/deploy/new/page.tsx` | User has to know the App must be installed first |
| G2 | **Any signed-in user can connect any repo the App is installed on.** `create` proves the *App* can see the repo, never that the *user* can | `backend/lib/projects/projects.service.ts` (`create` → `getRepoMetadata`) | User B can connect user A's private repo and read it through analysis or a deploy |
| G3 | Sign-in drops the GitHub token; a separate OAuth App is used for identity | `backend/lib/auth/github-oauth.ts`, `app/api/auth/github/callback/route.ts` | No way to list the user's installations or repos |
| G4 | Post-install redirect goes to `localhost:4001` | GitHub App settings | Dead page after every install |
| G5 | No encryption helper; `GitHubConnection.accessToken` is a plaintext column (always NULL) | `backend/prisma/schema.prisma` | Nowhere safe to keep a user token (also needed by Phases 6–9) |
| G6 | Webhook ignores every event except `push` | `backend/app/api/webhooks/github/route.ts` | An open repo list does not notice an install; a revoked authorisation leaves its token stored |
| G7 | Sign-out only clears the cookie | `backend/app/api/auth/logout/route.ts` | Stored GitHub tokens would outlive the session |

## Design decisions

1. **One GitHub App for identity and repo access.** Point the existing sign-in at the GitHub App's
   own Client ID / secret (`github-oauth.ts` already notes both kinds of app speak the same
   endpoints). The existing `/api/auth/github` + `/callback` *is* the connect flow, so the
   `/api/github/connect` and `/api/github/callback` routes named in `PLAN.md` are not added.
   Existing users keep their accounts: `upsertGithubUser` matches on the numeric GitHub user id.
2. **Store the user token encrypted; read repos live.** Installations and repositories are always
   fetched from GitHub with the user's token, never cached in our database. Nothing can go stale,
   and "which repos may this user see" stays GitHub's decision, including inside organisations.
3. **Do not trust the install redirect.** It arrives with `installation_id` and a `code` but without
   our state cookie, and GitHub documents `installation_id` as spoofable. The callback therefore
   does not exchange that code; it restarts sign-in through `/api/auth/github?next=/deploy/new`
   (state + PKCE as today). The App is already authorised, so the user sees no second prompt, and
   the fresh token sees the new installation.
4. **Extend `GitHubConnection`** instead of adding the `GithubAccount` model from `PLAN.md`; it
   already holds `githubUserId` and `githubUsername` and is what sign-in reads.
5. **The picker lives in `/deploy/new`**, replacing the URL box. No separate `/repositories` page.

## Steps

### 1. Secret box (G5) — new `backend/lib/crypto/secret-box.ts`
- `seal(plaintext): string` / `open(sealed): string`. AES-256-GCM, random 12-byte IV, output
  `v1.<iv>.<tag>.<ciphertext>` (base64url). The `v1` prefix is the key id, so a later rotation can
  add `v2` without a data migration.
- Key from `ENCRYPTION_KEY` (base64, 32 bytes). Same rule as `secret()` in
  `backend/lib/auth/session.ts`: required in production, fixed development key otherwise.
- This is the shared helper `PLAN.md` "Cross-cutting" lists for provider tokens and env vars.

### 2. Schema — `backend/prisma/schema.prisma`, new migration `…_github_user_tokens`
On `GitHubConnection`: drop `accessToken`; add `accessTokenEnc String? @db.Text`,
`refreshTokenEnc String? @db.Text`, `accessTokenExpiresAt DateTime?`,
`refreshTokenExpiresAt DateTime?`. Timestamp it after `202609300001_analysis_snapshot`.

### 3. Sign-in keeps the token (G3, G4, G7) — `backend/lib/auth/`, `backend/app/api/auth/`
- `github-oauth.ts`: `exchangeCodeForToken` returns
  `{ accessToken, expiresAt, refreshToken, refreshTokenExpiresAt }` (a GitHub App response carries
  `expires_in`, `refresh_token`, `refresh_token_expires_in`; absent fields become `null`). Add
  `refreshUserToken(config, refreshToken)` (`grant_type=refresh_token`). Update the header comment,
  which currently says the token is never kept.
- `users.ts`: `upsertGithubUser(profile, tokens)` writes the sealed tokens in the same transaction.
  `findPublicUser` adds `githubConnected: boolean` (a token is stored and refreshable).
- `callback/route.ts`: pass the tokens through. New first branch: `setup_action` present and no
  matching state cookie → redirect to `/api/auth/github?next=/deploy/new` (decision 3).
- `logout/route.ts`: read the session, null the four token columns for that user, then clear the cookie.

### 4. User-scoped GitHub calls — new `backend/lib/github/github-user.service.ts`
A class registered in `backend/lib/runtime.ts` as `services().githubUser` (pattern of
`ProjectsService`), taking `prisma`.
- Move `request()` / `describe()` out of `GithubAppService` into `backend/lib/github/http.ts` so both
  services share them; no behaviour change.
- `getToken(userId)`: open the stored token; if it expires within 60 s, refresh and persist.
  Refresh tokens are single-use, so keep one in-flight refresh per user. No token, or refresh
  rejected → `HttpError(409, "github_reconnect_required")`.
- `listInstallations(userId)` → `GET /user/installations`.
- `listRepositories(userId)` → `GET /user/installations/{id}/repositories`, 100 per page, at most 5
  pages per installation; report `truncated` beyond that.
- `canAccess(userId, repo)` → `GET /repos/{owner}/{repo}` with the user token; 200 → true, 404 → false.
- `listBranches(userId, repo)` → `GET /repos/{owner}/{repo}/branches`, 100 per page, at most 3 pages.

### 5. Close the cross-user hole (G2) — `backend/lib/projects/projects.service.ts`
`create` calls `githubUser.canAccess(userId, repo)` before `getRepoMetadata`. If false, answer 404
with the same text as "not installed", so the response does not reveal that a private repo exists.
`ProjectsService` takes `GithubUserService` in its constructor.

### 6. API routes (pattern of `backend/app/api/projects/[projectId]/route.ts`: `requireUser` → service → `toErrorResponse`)
| Method & path | Response |
|---|---|
| `GET /api/repositories` | `{ installUrl, installations: [{ id, account, accountType, repositorySelection, manageUrl }], repositories: [{ id, fullName, owner, name, private, defaultBranch, installationId, pushedAt, projectId }], truncated }` — `projectId` is set when this user already has a project for that repo (match on `Project.repoId`) |
| `GET /api/repositories/:owner/:repo/branches` | `{ defaultBranch, branches: [{ name, protected }] }` — owner/repo validated with `parseRepoUrl` from `backend/lib/github/repo-url.ts` |

`installUrl` comes from the existing `GithubAppService.installUrl`.

### 7. Webhook events (G6) — `backend/app/api/webhooks/github/route.ts`
Handled after the signature and dedupe checks, before the `push` branch. GitHub delivers all three
to every App without a subscription.
- `installation`, `installation_repositories` → `events.emit({ kind: "github", action })` so an open
  picker refetches. Add that variant to `AppEvent` in `backend/lib/events/events.service.ts`.
- `github_app_authorization` with `action: "revoked"` → null the token columns of the
  `GitHubConnection` whose `githubUserId` is `sender.id`.

### 8. Frontend — `frontend/app/(dashboard)/deploy/new/page.tsx`
- `frontend/lib/deploy/types.ts` + `client.ts`: `GithubRepository`, `RepositoryList`,
  `listRepositories()`, `listBranches(owner, repo)` (existing `withSession` pattern).
- New `frontend/components/RepositoryPicker.tsx`:
  - search box filtering on `fullName` (client-side), rows grouped by account, private badge;
  - an already-connected repo shows "Connected" and links to `/deploy/<projectId>`;
  - "Install on more repositories" link (`installUrl`); with no installations, that is the whole panel;
  - on `github_reconnect_required`, a "Reconnect GitHub" button using `githubLoginUrl("/deploy/new")`
    from `frontend/lib/api/auth.ts`;
  - `useAppEvents(load)` (`frontend/lib/deploy/useAppEvents.ts`) so an install made in another tab appears.
- Page: the picker replaces the Repository URL input. Once a repo is selected, Branch becomes a
  `<select>` filled from `listBranches`, default branch preselected. The other fields and the
  `POST /api/projects` body (`repoUrl`) are unchanged. A "Paste a URL instead" toggle keeps the old
  input for repos beyond the list cap; step 5 makes that path safe.
- `frontend/app/(dashboard)/deploy/page.tsx`: update the empty-state copy (no manual install step).

### 9. Configuration and docs
- **GitHub App settings** (manual, once): Callback URL → `http://localhost:3001/api/auth/github/callback`
  (replacing the `:4001` one); tick "Request user authorization (OAuth) during installation"; leave
  "Expire user authorization tokens" on; Account permissions → Email addresses: Read-only (so
  `fetchGithubProfile` still gets the verified primary email); generate a client secret.
- `backend/.env.example` + `README.md`: `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` now hold the GitHub
  App's values; add `ENCRYPTION_KEY` with its generation command.
- `PLAN.md`: tick the Phase 3 items and note decisions 1, 4 and 5. `frontend/docs/API_CONTRACT.md`:
  the two repository endpoints and the `github_reconnect_required` error.

## Out of scope
Monorepo restructure (Phase 1); passwords and refresh tokens for our own session (Phase 2); a
Settings page showing the connected GitHub account (Phase 10); key-rotation tooling; re-checking
the user's repo access on every later analyse or deploy of an existing project; GitHub Enterprise.

## Verification
1. `cd backend && npx prisma migrate dev && npm run typecheck && npm run lint && npm test`;
   `cd frontend && npm run typecheck && npm run lint && npm test`.
2. Unit tests (vitest, `fetch` stubbed as in `backend/lib/github/github.service.test.ts`):
   - `secret-box.test.ts`: round trip; tampered ciphertext or tag throws; unknown version throws;
     production without `ENCRYPTION_KEY` throws.
   - `github-user.service.test.ts`: refresh when near expiry and persist the rotated pair; two
     concurrent calls refresh once; no token → `github_reconnect_required`; pagination and the
     `truncated` flag; `canAccess` true/false.
   - `projects.service.test.ts`: `create` rejects a repo the user cannot access and never calls
     `getRepoMetadata`.
   - Callback route: install redirect without state bounces to `/api/auth/github` and exchanges
     nothing; normal sign-in stores sealed tokens (no plaintext in the row).
   - Webhook route: `installation` emits a `github` event; `github_app_authorization` revoked clears tokens.
   - Repository routes: 401 signed out; shape; invalid owner/repo → 400.
3. Manual, after updating the App settings and `backend/.env`:
   - Sign out and in: the `GitHubConnection` row has `accessTokenEnc` starting `v1.` and no plaintext.
   - `/deploy/new` lists repos; search narrows them; a connected repo links to its project.
   - Pick a repo → branch dropdown → Connect → the project page opens with its analysis, as today.
   - "Install on more repositories" → add a repo on GitHub → lands on `/deploy/new` (not `:4001`)
     with the new repo listed.
   - With a second GitHub account that cannot see repo X: `POST /api/projects` with X's URL → 404.
   - Revoke the authorisation on GitHub (Settings → Applications → Authorized GitHub Apps): the
     tokens are cleared and `/deploy/new` offers "Reconnect GitHub".
   - `npm run test:e2e` (push-to-deploy) still passes.
