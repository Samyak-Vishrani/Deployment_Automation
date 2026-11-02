# Render deployment workflow and testing

The real integration is under **Deploy → select a project → Deploy backend → Render**.
The older `/projects` dashboard can use mock fixtures; use `/deploy` for real deployments.

## Setup

1. Start PostgreSQL using the existing `docker compose up -d` setup. Keep your existing database backup before applying migrations.
2. In `backend/.env`, configure the existing GitHub App settings, `DATABASE_URL`, `AUTH_SECRET`, `FRONTEND_URL` and `ENCRYPTION_KEY`. For local development, `FRONTEND_URL=http://localhost:3000`. Render connections require an explicit encryption key, including in development. Generate one with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   Keep the key stable and backed up securely: changing it makes existing encrypted credentials unreadable. Do not commit `.env`.

3. Set `GROQ_API_KEY` to enable AI analysis. `GROQ_MODEL` is optional and defaults to `openai/gpt-oss-120b`. Without Groq, deployments and logs still work; the AI button explains what is missing.
4. Install dependencies and apply the committed additive migration:

   ```powershell
   cd backend
   npm ci
   npm run prisma:generate
   npm run prisma:deploy
   npm run dev
   ```

5. In another terminal:

   ```powershell
   cd frontend
   npm ci
   npm run dev
   ```

   Configure `frontend/.env` with `NEXT_PUBLIC_API_URL=http://localhost:3001`. Open `http://localhost:3000/deploy` and sign in through GitHub.

## Successful first deployment

1. Connect a GitHub repository and select its branch.
2. Open **Configure components**, retain/add the backend component, verify its folder and install/build/start commands, and save. A JavaScript Express API might use `npm ci`, no separate build command, and `npm start`. TypeScript apps usually need their build command too.
3. Follow **Deploy backend on Render**. In **Connect Render**, enter a key from Render account settings, click **Find workspaces**, select the intended workspace and connect. Keys are encrypted at rest and never returned by the API.
4. For a private repository, install/authorize Render's GitHub app for that repository. OrbitOps's GitHub app authorization does not grant Render access.
5. Choose the runtime, region and plan. Free is the default; paid plans are explicitly labeled and charged by Render. Availability and billing requirements are controlled by Render.
6. Set a health check path such as `/health` if the application exposes one. The app must bind to `0.0.0.0` and `process.env.PORT` (or the equivalent for its runtime).
7. Enter environment variables, including a reachable production database URL if needed. These are separate from the local Docker environment variables. Saving with **Replace all saved environment variables** replaces the whole Render set; an empty set clears it. Omit that checkbox to preserve saved secrets.
8. Click **Save Render settings**, then **Deploy on Render**.
9. Confirm that a single service appears in Render, status changes to `deploying`, logs arrive, and the final state is `live`. Open the backend URL and test an actual endpoint. Render's `live` state is the provider's deployment result; the application should also have an appropriate health check.
10. Deploy again. The same Render service must be reused with a new deployment record.

Deploy checks only the selected backend, so unfinished Vercel/Neon components do not block it. Database provisioning and frontend deployment are not part of this release.

## Failure and recovery tests

Use a disposable test repository/service for intentional failures.

| Test | Expected result |
| --- | --- |
| Wrong API key | Safe connection error; no credential value in the response |
| Missing required `.env.example` variable | Server-side preflight blocks deployment and identifies the missing key |
| Bad start/build command | Render reports failure; the app displays failed status and collected logs |
| **Analyze failure with AI** | Redacted stored log tail goes to Groq; summary, likely cause, evidence and suggestions appear |
| Missing/revoked Groq key | Deployment/logging still works; analysis returns a recoverable error |
| Double-click Deploy or retry the same request key | One deployment intent, no duplicate service creation |
| Refresh browser or restart OrbitOps during a build | Render continues; reopening the panel reconciles the stored deployment |
| Render outage or 429 | Safe retry message; no automatic POST retries |
| Log API outage | Deployment status can still update; log warning offers refresh/dashboard fallback |
| Log output containing a configured secret | The saved log and AI input/output mask the value |
| Signed-out requests to Render or analysis endpoints | HTTP 401 |
| Another user's project/component/deployment ID | HTTP 404; no provider action |
| Mutation from a missing/untrusted Origin | HTTP 403 |
| Editing during an active deployment | HTTP 409; active settings remain stable |

If a create/deploy response is lost, the record becomes `uncertain`. Refresh reconciles by the stable service name and deployment window. Ambiguous results are not guessed. After five minutes, **I checked Render — close unconfirmed request** lets you explicitly acknowledge the attempt after checking the Render dashboard. This does not cancel a remote deployment. Wait for any remote work to stop before acknowledging. A subsequent request must be a deliberate new deployment.

## Automated verification

Run in both `backend` and `frontend`:

```powershell
npm test
npm run lint
npm run typecheck
npm run build
```

Backend tests mock Render/Groq and test authentication, ownership, request limits, CSRF origins, secret redaction, service reuse, duplicate requests, uncertain outcomes and recovery. They do not spend money or create real cloud resources. The optional database integration test is documented with its script in `backend/test/render-db.mjs`.

For an isolated PostgreSQL test, run a disposable container (Docker Desktop must be running):

```powershell
docker run --name orbitops-render-db-test --rm -d -p 127.0.0.1:55433:5432 -e POSTGRES_PASSWORD=orbitops-test-only -e POSTGRES_DB=orbitops_render_test postgres:16
cd backend
# Use a separate terminal for this test so these variables do not affect normal app commands.
$env:DATABASE_URL = 'postgresql://postgres:orbitops-test-only@localhost:55433/orbitops_render_test'
$env:RENDER_TEST_DATABASE_URL = $env:DATABASE_URL
npm run prisma:deploy
npm run test:render-db
docker stop orbitops-render-db-test
```

The test refuses any database name other than `orbitops_render_test` and removes its own fixture rows.

On Windows, Next.js may need permission to create junctions for external backend packages. A sandbox-denied junction is an environment permission issue. Stale `.next/dev/types` from removed routes can also affect checks; regenerate Next.js types or remove only that generated types directory before rebuilding.

## Production deployment notes

- Apply migrations before starting the new backend. The database includes a partial unique index enforcing one active Render deployment per component, plus request-key uniqueness. Preserve this migration when evolving the Prisma schema; Prisma does not model partial indexes directly.
- Use HTTPS and a fixed `FRONTEND_URL`. This app's existing session cookies use `SameSite=Lax`; host the frontend and API on the same site, or proxy the API through the frontend origin. Unrelated frontend/API domains need a deliberate cookie/CSRF architecture change.
- Set a unique `AUTH_SECRET` and 32-byte base64 `ENCRYPTION_KEY`; keep both and database backups in your secret manager. Never expose the Render or Groq key as a `NEXT_PUBLIC_` variable.
- Permit outbound HTTPS to GitHub, `api.render.com`, and Groq. Render calls have 15-second timeouts and no automatic write retries; Groq has a 45-second timeout. Allow sufficient request time at the reverse proxy (at least 120 seconds for preflight and provider calls).
- Render executes the actual build independently. OrbitOps reconciles status while the panel is open or on manual refresh; a closed browser does not stop the deployment. No always-running worker or webhook is required for this release. Notifications while every browser is closed are not implemented.
- Logs are a bounded tail of up to 1,000 service log entries / 60,000 characters, scoped to the deployment time window. Render's logs API has no deployment-ID filter here, so output from the previous running instance can appear. Full logs remain in Render, subject to its retention. The AI receives up to 24,000 characters and must be treated as advisory.
- Analysis is initiated explicitly, caches its result, and cannot execute commands, modify repositories, or redeploy. Failed analysis can be retried after two minutes; concurrent requests are guarded in the database.
- Runtime, region and plan are fixed in this UI after service creation. Manage infrastructure changes in Render. Commands/environment are managed by OrbitOps on each redeploy; do not rely on manual dashboard environment changes surviving an OrbitOps deploy.
- Render auto-deploy is disabled to avoid duplicate triggers. Existing GitHub-to-local-Docker deployment settings remain independent. Disable local auto-deploy if you want only manual Render deployment.
- Projects/components with Render configuration are protected from deletion to preserve resource links/history. Hosted services must be managed/deleted explicitly in Render. Disconnecting only removes OrbitOps's stored credential and never deletes hosted resources.
- For a real production release, complete the successful deployment and failure-analysis smoke tests with your own Render/GitHub/Groq credentials. Automated mocks cannot verify workspace billing, repository authorization, app-specific commands, or production database connectivity.

Official references: [Render API](https://render.com/docs/api), [create service](https://api-docs.render.com/reference/create-service), [logs](https://api-docs.render.com/reference/list-logs), [Git provider access](https://render.com/docs/git-provider).
