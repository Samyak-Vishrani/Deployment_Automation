# Phase 12 — Logs: implementation plan

> Executed on 2026-11-04 ("execute phase 12 step by step thoroughly"). The plan below is kept as written; the
> status block says what was built and where it differs.
>
> **Status: code implemented and tested (2026-11-04); runtime tails checked live against the real
> Render and Vercel APIs; a full UI pass is still to do.**
>
> | Step | State | Where |
> |---|---|---|
> | 0. API check | ✅ (docs + live probes) | Vercel `runtime-logs` = `application/stream+json` rows (`rowId`, `timestampInMs`, `level`, `message`, request fields, `source`); Render `/v1/logs` labels `type`, `level`, `method`, `path`, `statusCode`. Spike scripts `npm run spike:runtime` in both services (need your token; not run). See the measured findings below |
> | 1. Scaffold | ✅ | `backend/logs` (:3005, Fastify, no database), `.env.example`; backend excludes `logs/**` |
> | 2. Contract + mappers | ✅ | `integration_common` contract (`EventLogLine` with `origin` + `phase`, `LogEntry`, `RuntimeLogLine`, `RuntimeLogEvent`); runners tag lines; runtime mappers + fixtures |
> | 3. Store | ✅ | `LogStore`: JSONL + meta, serialised appends, `clientSeq` dedupe, 20 MB cap, legacy `.log` reads, ANSI stripped |
> | 4. Build-log API | ✅ | ingest, close, entries, text, NDJSON stream (race-free); `ndjson.ts` in common |
> | 5. Backend seam | ✅ | `LogsServiceClient`, `RemoteLogWriter` (batches, retries, 5000-line buffer, local tail), `RemoteLogs`, `ProviderLogSink`, Docker executor; routes `/logs`, `/logs/download`, `/logs/stream` (`id: seq`, `Last-Event-ID`) |
> | 6. Proxies + tailers | ✅ | `/log-proxy` in Vercel and Render (own token); `tailRender`, `tailVercel`, `tailDocker`, `RuntimeSessions` |
> | 7. Backend runtime + index | ✅ | `RuntimeLogsService` (ownership, env-secret redaction), SSE routes, ping, `GET /api/projects/:id/logs` |
> | 8. Frontend | ✅ | `LogPane`, `useBuildLogStream`, `useRuntimeLogStream`, the Logs page, build page, project page links |
> | 9. Docs | ✅ | README "Logs" + Terminal 6 + env tables, `backend/logs/README.md`, service READMEs, `API_CONTRACT.md`, `PLAN.md` |
>
> **Verification so far:**
> - typecheck and tests pass everywhere: backend 382 (was 366), `logs` 39 (new),
>   `integration_common` 47 (42), `vercel_integration` 103 (97), `render_integration` 102 (96),
>   `neondb_integration` 66, frontend 12 (9); lint is clean and `next build` passes for both apps;
> - **live, real HTTP:** ingest, retried-batch dedupe, live stream then `done`, text, the two tokens
>   kept apart (each gets 401 on the other's routes), errors passed through
>   (`not_deployed`, `not_running`);
> - **live, the backend's `RemoteLogWriter` against the running service:** redaction, sources,
>   tail; with the service stopped, `close` falls back to its own tail in under 5 s;
> - **live, real Render:** the backend's app logs streamed (`listening on http://0.0.0.0:10000`),
>   ANSI stripped;
> - **live, real Vercel:** connected; no lines, because the test site is all static pages.
>
> **Measured on the real APIs, which changed the design:**
> - **Render allows 30 log reads a minute** (`ratelimit-limit: 30`):
>   - the default poll is 3 s, not 2 s;
>   - the next read waits for the reset when at most 2 reads are left;
>   - the backfill is one newest-first page (`direction=backward`, 100 lines), not 200 oldest-first
>     lines;
>   - transient failures are retried, and 5 in a row end the stream.
> - **Vercel's runtime-logs endpoint sends nothing, not even headers, until there is a log line**
>   (the events endpoint answers in under 1 s). So:
>   - the tailer reports "connected" without waiting;
>   - a refusal within 3 s is still an HTTP error;
>   - it reconnects quietly whenever Vercel closes the stream.
> - Render app messages carry ANSI colour codes; they are stripped on ingest and in the runtime
>   mappers.
>
> **Deviations from the plan:**
> - The backfill is at most 100 lines, not 200 (one Render page, one read of the rate limit).
> - `isErrorLine` ignores stderr from Docker, because `docker build --progress plain` writes all
>   its progress to stderr.
> - The runtime SSE starts with a `session` event carrying `{ sessionId, source }`.
> - Integration-service lines carry `origin` (`orbitops` | `provider`), so OrbitOps' own lines
>   relayed by a service are tagged `orbitops`, not as the provider.
> - Superseded files, renamed under the mark-don't-delete rule:
>   - `backend/lib/deployments/xxx_deployment-logs.service.ts`;
>   - `frontend/components/xxx_BuildLog.tsx`;
>
>   the backend and frontend configs now exclude `**/xxx*`.
> - Local dev setup: new random tokens were added to `backend/.env`, `backend/logs/.env` (new),
>   `vercel_integration/.env` and `render_integration/.env`.

## Context

PLAN.md Phase 12 is 🟡.

**What exists today:**
- Every deployment already has its **own** log file, `backend/data/logs/<projectId>/<deploymentId>.log`,
  written inside the main backend by `DeploymentLogWriter` (`backend/lib/deployments/deployment-logs.service.ts`):
  - redacted;
  - fanned out on an in-process bus;
  - streamed by `GET /api/deployments/:id/logs/stream` (SSE, replay then tail);
  - shown on `/deploy/builds/<id>` by `components/BuildLog.tsx`.

**What is wrong with it:**
- **The file is flat text.** `ProviderDeploymentsService.applyEvents` (`case "logs"`) keeps only
  `line.text` and drops:
  - its source;
  - its `stream` (stdout/stderr);
  - its provider timestamp;
  - Render's `type` label (build vs app).
- **There is no per-component view.**
- **Once a component is live, nothing is shown** (no Render app logs, no Vercel runtime logs).
- **Known gaps in the stream route:**
  - lines written between the history read and the subscribe are lost;
  - there is no resume after a reconnect;
  - there is no copy, download, search or error highlighting.

**User's requirements (2026-11-04):**
1. **Logs are always per component and per provider.** Vercel logs and Render logs are shown
   separately, and never merged. A combined, time-ordered log is only for the AI assistant
   (Phase 13): out of scope here, but the storage must make it possible.
2. **Build logs + real-time runtime logs** per component.
3. **Where they are viewed:** a new **project Logs page** with one tab per component, plus the
   existing **build page**, which gains filters, search, copy and download.
4. **All log code goes in a new microservice, `backend/logs/`**, run like `vercel_integration`:
   - It is **one** service for logs as a whole: storage, ingest, reading, live streams, and the
     Vercel, Render and Docker runtime tailing.
   - There is **no** separate Vercel-logs or Render-logs service.
5. **The logs service reaches Vercel and Render through a narrow proxy route** in each
   integration service (decided 2026-11-04). Provider tokens never leave the service that seals
   them.

**Done when:**
- On `/deploy/<id>/logs`, a project with `web` (Vercel), `api` (Render) and `database` (Neon) shows
  three tabs: **web · Vercel**, **api · Render**, **database · Neon**.
  - **Build** shows one deployment's log: our setup lines plus that provider's output, each tagged
    with its source, with errors highlighted.
  - **Runtime** streams Render app logs on `api`, and Vercel function logs on `web`, live.
  - Neon explains that it has no runtime log API.
  - No tab ever shows another component's lines.
- **Storage:** every build-log line is stored by `backend/logs`. The main backend keeps no log
  files.
- **Resilience:** the build page resumes after a reconnect without gaps or duplicates. Stopping the
  logs service never fails a deploy: lines are buffered and delivered once it is back.

---

## Constraint: one folder per service; `backend/logs` owns all log code

| Process | Folder | Port | Storage |
|---|---|---|---|
| Main backend (Next.js) | `backend/` | 3001 | Postgres `public` |
| Vercel integration | `backend/vercel_integration/` | 3002 | Postgres `vercel` |
| Render integration | `backend/render_integration/` | 3003 | Postgres `render` |
| Neon DB integration | `backend/neondb_integration/` | 3004 | Postgres `neon` |
| **Logs (Fastify)** | **`backend/logs/`** | **3005** | **files: `backend/logs/data/<projectId>/<deploymentId>.jsonl` + `.meta.json`** (no database) |
| Shared library | `backend/integration_common/` | — | — |

**Rules** (as for the other services):
- **Standalone.** It has its own `package.json`, Node 22 + `tsx` (no build step), Fastify 5 and
  Vitest. It imports only its own `src/` and `@orbitops/integration-common`, never `backend/lib/**`
  or another service.
- **Loopback only:** `127.0.0.1:3005`. Every route except `/health` needs
  `x-internal-token: <LOGS_SERVICE_TOKEN>`, compared in constant time.
- **Never seen by the browser.** The main backend checks ownership (user → project → deployment or
  component) and proxies.
- **No provider tokens.** For Vercel and Render it calls their integration service's
  **log-proxy** routes with its own `LOGS_PROXY_TOKEN`. That token is accepted **only** on those
  routes, never on deploy or credential routes.
- **What stays outside `backend/logs`:**
  - **Integration services:** the build-log pull during a deploy stays in their deploy runners,
    because it is part of the deploy. The only changes are tagging `phase` on those lines, and the
    one read-only log-proxy route each.
  - **Main backend:** thin seams only:
    - a `LogsServiceClient`;
    - a buffering `RemoteLogWriter`, replacing the file writer;
    - proxy routes with ownership checks;
    - env-secret redaction of runtime lines, because only the backend knows the component's secret
      values.

**Data flow:**
```
Build log:   provider ──pull (deploy runner)──▶ vercel/render_integration ──event batch──▶ backend
             backend (ownership, redaction, Docker/our own lines) ──POST entries──▶ logs (JSONL + bus)
             browser ──SSE──▶ backend ──NDJSON stream──▶ logs

Runtime log: browser ──SSE──▶ backend (ownership, env-secret redaction) ──NDJSON──▶ logs (tailer)
             logs ──GET log-proxy──▶ vercel/render_integration (adds token) ──▶ Vercel / Render API
             logs ──docker logs --follow──▶ local container
```

---

## Design choices (recommended defaults; change before executing if needed)
- **Build logs are structured JSONL**, one entry per line:
  `{ seq, at, source, phase, stream, text }`.
  - `source`: `orbitops` | `vercel` | `render` | `neon` | `docker`.
  - `phase`: `setup` | `build` | `deploy` | `runtime`.
  - `stream`: `info` | `stdout` | `stderr`.
  - `seq` is assigned by the logs service, so it is monotonic per deployment.
  - Existing `backend/data/logs/**/*.log` files stay readable: the logs service reads them
    read-only through `LEGACY_LOG_DIR` and parses `[hh:mm:ss] text`.
- **One deployment = one provider.** No route of either the logs service or the backend returns
  lines of two deployments or components together. Phase 13 will merge `entries` of each
  deployment of a release by `at` itself.
- **Ingest is idempotent.** The backend numbers what it sends (`clientSeq`). The logs service keeps
  `lastClientSeq` per deployment and drops anything at or below it, so a retried batch never
  duplicates.
- **The logs service being down never fails a deploy.** `RemoteLogWriter`:
  - buffers up to 5000 entries per deployment and retries with backoff;
  - beyond that it drops the oldest, and later writes "N log lines were lost while the logs service
    was unavailable";
  - `Deployment.logTail` falls back to the writer's in-memory tail when `close` cannot reach the
    service.
- **Runtime logs are never stored.** The tailers run in the logs service only while someone
  watches. How each provider is tailed:
  - **Render:** polls `GET /v1/logs` (`type=app`, plus `type=request` if asked) every 2 s, through
    the proxy, starting at a cursor and deduped by id, with a 15-minute backfill of at most 200
    lines.
  - **Vercel:** the runtime-logs stream of the component's current production deployment,
    streamed through the proxy.
  - **Neon:** none; the tab explains.
  - **Local Docker:** `docker logs --follow --timestamps --since 15m`, spawned by the logs service
    on the same machine.
- **Limits:**
  - 3 runtime streams per user, counted in the logs service (409 `runtime_logs_busy`);
  - 15 minutes without a viewer ping, or 60 minutes in total, then an `end` event and **Resume**;
  - build logs capped at 20 MB per deployment, with a final "log truncated" entry;
  - the browser keeps 10 000 lines per pane;
  - an ingest batch is at most 500 entries or 1 MB.
- **Redaction**, in three places:
  1. The backend redacts build lines before sending (`redact()` + the deployment's secrets, as
     today's writer does).
  2. The logs service applies the generic `redact()` from `integration_common` again on ingest and
     on runtime lines, as a backstop: token shapes, URLs with passwords.
  3. The backend redacts runtime lines with the component's secret env values and Neon connection
     strings before they reach the browser.

---

## Steps

### 0. API spike (½ day, existing Vercel and Render tokens)
Add a `runtime` mode to `vercel_integration/scripts/vercel-spike.ts` and
`render_integration/scripts/render-spike.ts` against `Vercel_Integration_test`. Save redacted
samples to `backend/logs/src/providers/__fixtures__/`.

| Question | Call |
|---|---|
| Vercel runtime-log shape | `GET /v1/projects/:projectId/deployments/:deploymentId/runtime-logs`: content type, the fields per line (`timestampInMs`, `level`, `message`, `requestPath`, `responseStatusCode`, `source`…), and how long the stream stays open |
| Vercel scope and retention | Is `teamId` required? Does it work on Hobby? How far back can it read (backfill)? |
| Vercel current deployment | the last `live` `vercelDeploymentId` we stored, or `GET /v9/projects/:id` → `targets.production.id` |
| Render app and request logs | `GET /v1/logs?resource=srv-…&type=app\|request&direction=forward&startTime=…`: the labels, paging, and the rate-limit headers at a 2 s poll |
| Render subscribe | Does `wss://api.render.com/v1/logs/subscribe` take a bearer key? Note only; polling is the baseline |

### 1. Scaffold `backend/logs/`
- **Files:**
  - from `neondb_integration`'s skeleton: `package.json` (name `orbitops-logs`,
    `"@orbitops/integration-common": "file:../integration_common"`), `tsconfig.json`,
    `vitest.config.ts`, `.gitignore` (`data/`, `.env`), `.env.example`, `README.md`;
  - `src/server.ts`, `src/app.ts`, `src/config.ts`.
- **`config.ts`:**
  - `PORT` 3005, `HOST` 127.0.0.1;
  - `LOGS_SERVICE_TOKEN` (from the backend);
  - `DATA_DIR` (default `./data`), `LEGACY_LOG_DIR` (default `../data/logs`);
  - `VERCEL_SERVICE_URL`, `RENDER_SERVICE_URL`, `LOGS_PROXY_TOKEN` (the same value set in both
    integration services);
  - `MAX_LOG_BYTES` (20 MB), `RUNTIME_STREAM_MAX_MS` (60 min), `RUNTIME_IDLE_MS` (15 min),
    `RENDER_RUNTIME_POLL_MS` (2000), `MAX_STREAMS_PER_USER` (3).
- **`app.ts`:** the internal-token hook (`@orbitops/integration-common/internal-auth`), and the
  `ProviderError` → `{ error, message }` mapping, as in the other services.
- **`server.ts`:**
  - **Graceful shutdown:** close every open runtime tailer and flush every file stream.
  - **On boot:** nothing to resume. Files are appended to as ingest arrives.
- **Main backend wiring:**
  - `backend/.env.example` gets `LOGS_SERVICE_URL` (default `http://127.0.0.1:3005`) and
    `LOGS_SERVICE_TOKEN`;
  - the backend's `tsconfig.json`, `vitest.config.ts` and `eslint.config.mjs` exclude `logs/**`.

### 2. Contract and mappers
- **`integration_common/src/contract.ts`:**
  - `LogLine` gains `phase?: "build" | "runtime"`;
  - new `RuntimeLogLine = { id, at, stream: "stdout" | "stderr", level?, text, request?: { method?, path?, status? } }`;
  - new `LogEntry`, `LogSource`, `LogPhase`, `LogStream` (the stored shape above);
  - new `RuntimeLogEvent = { type: "line", line } | { type: "notice", text } | { type: "end", reason, message } | { type: "heartbeat" }`.
- **Integration services, build logs only:**
  - `render_integration/src/render/log-map.ts`: `toLogLine` sets `phase` from the `type` label
    (`build` → build, `app` → runtime);
  - Vercel's build-event mapper sets `phase: "build"`, and `stream: "stderr"` for
    stderr/error events.
- **`backend/logs/src/entries/`:**
  - `entry-text.ts`: `entryToText(entry)` → `[12:03:04] [render] text`;
  - `legacy.ts`: `parseLegacyLine(line, seq)`;
  - `errors.ts`: `isErrorLine(entry)` (stderr, or `/\b(error|failed|fatal|exception|ERR!)\b/i`).
    The frontend keeps a copy, with a test that checks they match, as in Phase 9.
- **`backend/logs/src/providers/`** (runtime mappers):
  - `render-runtime.ts`: `toRuntimeLine(entry, { includeRequests })` from a `/v1/logs` entry;
  - `vercel-runtime.ts`: `toRuntimeLine(raw)` from one runtime-log JSON line.
- Unit tests for each, on the step-0 fixtures.

### 3. Storage in the logs service (`backend/logs/src/store/`)
- **`log-store.ts`, `LogStore`:**
  - **Opening:** `open(deploymentId, { projectId, componentId, provider })` opens or creates
    `data/<projectId>/<deploymentId>.jsonl` plus `.meta.json`:
    `{ projectId, componentId, provider, nextSeq, lastClientSeq, bytes, truncated, status, closedAt }`.
    Writers are kept open per active deployment, and closed on `close` or after 10 minutes idle.
  - **`append(deploymentId, entries, clientSeq)`:**
    - drops entries with `clientSeq ≤ lastClientSeq`;
    - applies the generic redaction backstop;
    - assigns `seq`, appends one JSON line per entry, and updates the meta;
    - emits `{ type: "entry", entry }` on the in-process bus;
    - stops at `MAX_LOG_BYTES`, after one `{ source: "orbitops", text: "Log truncated at 20 MB." }`
      entry.
  - **Reading:**
    - `read(deploymentId, { afterSeq?, limit? })` reads `.jsonl`, or falls back to
      `LEGACY_LOG_DIR/<projectId>/<deploymentId>.log` through `parseLegacyLine`;
    - `text(deploymentId)` renders with `entryToText`;
    - `tail(deploymentId, 64 KB)`.
  - **Closing:** `close(deploymentId, status)` sets the meta's `status` and `closedAt`, and emits
    `done`.
  - **Subscribing:** `subscribe(deploymentId, listener)`.
  - **Where a log lives:** the meta file maps `deploymentId` → `projectId`, so readers need only
    the deployment id. A tiny in-memory index is built lazily from a scan, or the backend passes
    `projectId` with each call; use the latter, as it is simpler.
- **Tests:**
  - append/read round trip;
  - `seq` continues after a reopen;
  - duplicate `clientSeq` dropped;
  - the 20 MB cap writes one truncation entry;
  - legacy `.log` fallback;
  - concurrent appends stay ordered (one write queue per deployment).

### 4. Logs-service build-log API (`backend/logs/src/app.ts`, `src/routes/build-logs.ts`)

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness (no token) |
| `POST /deployments/:deploymentId/entries` | body `{ projectId, componentId, provider, clientSeq, entries: [{ text, at?, source, phase, stream }] }` (≤ 500 entries / 1 MB) → `{ nextSeq, accepted }` |
| `POST /deployments/:deploymentId/close` | `{ projectId, status }` → `{ tail }` (64 KB text, for `Deployment.logTail`) |
| `GET /deployments/:deploymentId/entries?projectId=&afterSeq=&limit=` | `{ entries, nextSeq, complete, truncated }` (limit ≤ 5000) |
| `GET /deployments/:deploymentId/text?projectId=` | the whole log as text (download, the legacy `/logs`) |
| `GET /deployments/:deploymentId/stream?projectId=&afterSeq=` | NDJSON: `{type:"entry",entry}` … `{type:"done",status}`, plus a heartbeat every 15 s |

**The stream is race-free:**
1. subscribe first, buffering;
2. replay `read(afterSeq)`;
3. flush the buffered entries with `seq > last replayed`;
4. pass the bus through;
5. a closed log replays, then sends `done`.

**`integration_common/src/ndjson.ts`** (shared by all streams here and the backend client):
- `writeNdjson(reply, iterator, signal)`: `reply.hijack()`, `content-type: application/x-ndjson`,
  heartbeats, and the iterator aborted on client close;
- `readNdjson(body, signal)`: an async iterator that tolerates partial chunks and skips (and
  counts) bad lines.

### 5. Main backend seam for build logs
- **`lib/logs/logs-service.client.ts`:**
  - `LogsServiceClient extends IntegrationServiceClient`, using `LOGS_SERVICE_URL` and
    `LOGS_SERVICE_TOKEN`, with the unavailable code `logs_service_unavailable`;
  - methods: `append`, `close`, `entries`, `text`, `openStream(path, signal)`;
  - `openStream` is a new `IntegrationServiceClient` method: no timeout, aborted by the signal,
    returns the body, and maps non-200 responses like `call()`.
- **`lib/logs/remote-log-writer.ts`, `RemoteLogWriter`:** the **same public surface** as
  `DeploymentLogWriter`, so the callers barely change.
  - **Writing:**
    - `write(text, meta?: { source?, phase?, stream?, at? })`;
    - `section(title)`;
    - `addSecret(secret)`;
    - redaction with `redact(text, secrets)` before anything leaves the process, as now.
  - **Delivery:** an in-memory queue, flushed every 250 ms or every 200 entries with a
    `clientSeq`, retried with backoff, and buffered up to 5000 entries. On overflow it drops the
    oldest, and adds the "lines lost" entry once the service answers again.
  - **Fallback tail:** it keeps the last 2000 rendered lines in memory, as the fallback for
    `logTail`.
  - **Closing:** `close(status)` flushes, calls the service's `close`, and returns the tail. If the
    service cannot be reached, it uses the local tail, so the deploy is still recorded.
- **`lib/logs/remote-logs.ts`, `RemoteLogs`:** replaces `DeploymentLogsService`.
  - `open(projectId, deploymentId, { secrets, defaultSource, componentId, provider })` →
    `RemoteLogWriter`.
  - `read(projectId, deploymentId)` → text, through the client.
- **`lib/common/data-dir.ts`:** `resolveDataDir` moves here, because `DeployExecutor` still needs
  it for its work dir.
- **Callers:**
  - **`DeployExecutor`** (local Docker): `docker build` output gets `source: "docker"`,
    `phase: "build"`; container start and health lines get `phase: "deploy"`; sections stay
    `orbitops`.
  - **`ProviderLogSink`:**
    - `write(projectId, deploymentId, lines, source)` takes strings or
      `{ text, at, stream, phase }`;
    - `addSecrets`, as now;
    - `close` returns the service's tail.
  - **`applyEvents`, `case "logs"`:** passes each line's `at`, `stream` and `phase`, with
    `source = deployment.provider`.
  - **Our own lines:** `orbitops`, with `phase: "setup"` or `"deploy"`.
  - **Neon provisioning lines:** `source: "neon"`.
  - **`lib/runtime.ts`:** builds `LogsServiceClient` and `RemoteLogs`, and passes them where `logs`
    went before.
- **Routes**, all with ownership checked through `getOwnedDeployment`:
  - `GET /api/deployments/:id/logs`: `{ id, log }` text as before; `?format=entries&afterSeq=&limit=`
    → `{ id, componentId, provider, entries, nextSeq, complete }`.
  - `GET /api/deployments/:id/logs/download`: `text/plain` from the service's `/text`, with
    `content-disposition: attachment; filename="<project>-<component>-<provider>-<sha7>-<id>.log"`.
  - `GET /api/deployments/:id/logs/stream`: SSE built from the service's NDJSON stream.
    - Each message is `event: entry`, `id: <seq>`, `data: <LogEntry>`; then `done`.
    - It honours `Last-Event-ID` and `?afterSeq` (forwarded as `afterSeq`).
    - `lib/api/sse.ts` `SseMessage` gains an optional `id`.
    - The old `line` event is removed; `BuildLog` is its only consumer.
- **Retired** under the mark-don't-delete rule, once nothing imports them:
  - `lib/deployments/deployment-logs.service.ts` → `xxx_deployment-logs.service.ts`;
  - its test → `xxx_…`.

### 6. Runtime logs: integration-service proxies and logs-service tailers
- **`vercel_integration`: new log-proxy route**
  `GET /log-proxy/components/:componentId/runtime-logs?userId=&since=`:
  - **Auth:** `x-logs-token: <LOGS_PROXY_TOKEN>` only. The regular internal token is not accepted
    here, and `LOGS_PROXY_TOKEN` is not accepted anywhere else.
  - **Lookup:**
    - the `VercelProject` for the component;
    - the newest `live` `VercelDeployment` (or the step-0 choice; 404 `not_deployed` if none);
    - the user's token (412 `vercel_token_invalid` / `vercel_not_connected`).
  - **Upstream:** builds the upstream URL itself (never from the caller), opens it with
    `providerFetch`, and **pipes the body back unchanged**, with an `x-vercel-deployment-id`
    response header. It aborts upstream when the caller disconnects.
  - **No parsing, polling or storage** here.
- **`render_integration`: new log-proxy route**
  `GET /log-proxy/components/:componentId/logs?userId=&type=app|request&startTime=&limit=`:
  - **Auth:** the same as Vercel's.
  - **Lookup:** the `RenderService` row (404 `not_deployed`) and the key.
  - **Upstream:** one `GET /v1/logs` page for that service (fixed `resource`, `ownerId` and
    `direction=forward`). It returns Render's JSON body and the rate-limit headers.
  - **No looping** here.
- **`backend/logs/src/runtime/`:**
  - **`proxy-client.ts`:** calls the two proxy routes with `x-logs-token`, mapping 404/412/503 to
    `ProviderError`s:
    - `not_deployed`;
    - the provider's credential codes;
    - `vercel_service_unavailable` / `render_service_unavailable`.
  - **`render-tail.ts`:** `tailRender(userId, componentId, { sinceMs, includeRequests, signal })`,
    an async generator:
    - backfill from `now - sinceMs` (≤ 200 lines);
    - then poll every `RENDER_RUNTIME_POLL_MS` through the proxy;
    - dedupe by id (an LRU of 2000);
    - on 429 / `ratelimit-remaining` low, back off to 10 s with a `notice`;
    - map with `toRuntimeLine`.
  - **`vercel-tail.ts`:** `tailVercel(userId, componentId, { signal })` uses `readNdjson` over the
    proxied stream, maps with `toRuntimeLine`, and reconnects once with `since = last at` and a
    `notice` when the upstream closes on its own.
  - **`docker-tail.ts`:** `tailDocker(containerName, { sinceMs, signal })` spawns
    `docker logs --follow --timestamps --since …`, parses the timestamps, gives stderr lines
    `stream: "stderr"`, and kills the child on abort. The container name must match
    `^orbitops-[a-z0-9-]+$`.
  - **`runtime-session.ts`:**
    - wraps a tailer with the per-user limiter (`integration_common/src/stream-limiter.ts`, 409
      `runtime_logs_busy`);
    - adds the max-duration and idle cutoffs (a `ping` resets idle);
    - adds the generic redaction;
    - turns everything into `RuntimeLogEvent`s.
- **Logs-service runtime routes:**

  | Method & path | Purpose |
  |---|---|
  | `GET /runtime/components/:componentId/stream?userId=&provider=vercel\|render&since=&requests=` | NDJSON `RuntimeLogEvent`s; header `x-session-id` |
  | `GET /runtime/docker/:containerName/stream?userId=&since=` | the same, for the local container |
  | `POST /runtime/sessions/:sessionId/ping` | resets the idle timer |
- **Tests:**
  - **Proxy routes:** the token separation (the internal token gets 401 on `/log-proxy`, the
    logs-proxy token gets 401 on `/deployments`), 404 `not_deployed`, the body piped unchanged,
    and upstream aborted on disconnect.
  - **Tailers:** fixtures split at odd chunk boundaries, backfill then poll, dedupe, backoff,
    abort stops the proxy fetch.
  - **Session:** the limiter returns 409 on the 4th stream; idle and max-duration `end`; no token
    in any line.

### 7. Main backend seam for runtime logs, and the logs index
- **`LogsServiceClient`** gains `openRuntime(userId, componentId, provider, opts, signal)` →
  `{ body, sessionId }`, `openDockerRuntime(…)` and `ping(sessionId)`.
- **`lib/logs/runtime-logs.service.ts`, `RuntimeLogsService`** (thin):
  - **Ownership:** user → project → component.
  - **By provider:**
    - `vercel` / `render` → `openRuntime`;
    - `neon` → 400 `runtime_logs_unsupported` ("Neon has no runtime log API; see the Neon
      console's Monitoring tab");
    - local Docker → `openDockerRuntime("orbitops-<slug>")`.
  - **Redaction:** each line passes through `redact(text, secrets)`. `secrets` = the component's
    secret values from `EnvVarsService.resolve`, plus both Neon connection strings for a backend
    with a database. They are fetched once per stream.
- **Routes** (SSE via `lib/api/sse.ts` + `startHeartbeat`):

  | Route | Purpose |
  |---|---|
  | `GET /api/projects/:projectId/components/:componentId/runtime-logs/stream?since=5m\|15m\|1h&requests=0\|1` | one component's live logs |
  | `GET /api/projects/:projectId/runtime-logs/stream?since=…` | the project's local Docker container |
  | `POST /api/projects/:projectId/runtime-logs/:sessionId/ping` | keeps the stream alive while the tab is visible |

  - **Events:** `entry` (a `RuntimeLogEntry`: a runtime line plus `source`), `notice` (`{ text }`),
    `end` (`{ reason: "idle" | "max_duration" | "redeployed" | "error", message }`).
  - The first event is `session` (`{ sessionId }`), which the browser needs for the ping.
  - Errors before streaming are JSON (`toErrorResponse`): `runtime_logs_busy`,
    `runtime_logs_unsupported`, `not_deployed`, `logs_service_unavailable`.
- **Logs index** `GET /api/projects/:projectId/logs` is built in the backend from its own
  `Component` and `Deployment` rows. It is deployment metadata, not log content.
  ```ts
  type LogsIndex = {
    components: Array<{
      componentId: string; name: string; kind: ComponentKind; provider: ProviderId;
      runtime: "available" | "not_deployed" | "unsupported";
      runtimeNote: string | null;
      deployments: Array<{ id, status, trigger, queuedAt, finishedAt, commitSha, commitMessage, releaseNumber: number | null }>; // newest first, max 20
    }>;
    docker: { deployments: [...]; runtime: "available" | "not_running" } | null;
  };
  ```

### 8. Frontend (unchanged by the service split: the browser only ever talks to the backend)
- **`lib/deploy/types.ts`:** `DeployLogEntry`, `RuntimeLogEntry`, `LogSource`, `LogsIndex`.
- **`lib/deploy/log-format.ts`:** `isErrorLine` (a copy, with a sync test against
  `backend/logs/src/entries/errors.ts`), `formatTime`, `entryToText`.
- **`lib/deploy/useBuildLogStream.ts`:**
  - an EventSource on `/logs/stream`;
  - appends `entry` events in `seq` order and drops duplicates, so a reconnect with
    `Last-Event-ID` is seamless;
  - `done` closes it;
  - caps at 10 000 entries.
- **`lib/deploy/useRuntimeLogStream.ts`:**
  - start/pause/resume;
  - `since` and `requests` options;
  - handles `session`, `notice` and `end`;
  - pings every 60 s while `document.visibilityState === "visible"`;
  - closes on unmount and tab switch.
- **`components/LogPane.tsx`** (replaces `BuildLog`):
  - **Rows:** time (toggle), a source badge (its own colour per source), and the text. A runtime
    row also shows `level` and `GET /path 200` request lines.
  - **Error lines** are tinted, with a count and ↑/↓ jump.
  - **Toolbar:**
    - source chips, for the sources present only;
    - **Errors only**;
    - **Search** (n of m, Enter / Shift+Enter);
    - **Wrap**;
    - **Copy** (visible lines);
    - **Download** (the build route; for runtime, a blob of what is on screen).
  - **Autoscroll** keeps today's rule (only while pinned), plus a "Jump to latest" pill.
  - **Mobile:** the toolbar wraps, and the time column hides under 560 px.
- **Build page `deploy/builds/[deploymentId]/page.tsx`:**
  - uses `useBuildLogStream` + `LogPane`;
  - the title shows **component · provider**, plus "All logs of <component>".
- **New Logs page `deploy/[projectId]/logs/page.tsx`:**
  - **Tabs:** one per component (`<name> · <Provider>`, ordered frontend, backend, database), plus
    **Docker** when the project has local Docker deploys. Only one stream is open at a time.
  - **Build / Runtime switch per tab:**
    - **Build:** a deployment picker (status, `#release`, sha, relative time; the latest is the
      default), then `LogPane`.
    - **Runtime:**
      - a header: "Live from Render · not stored by OrbitOps";
      - a `since` select (5 m / 15 m / 1 h);
      - **Include requests** (Render);
      - **Pause / Resume**;
      - `end` → a **Resume** banner;
      - `not_deployed` → "Deploy it first";
      - Neon → its note plus a console link;
      - `logs_service_unavailable` → "The logs service is not running (Terminal 6)".
  - **URL state:** `?c=<componentId>&view=build|runtime&d=<deploymentId>`.
- **Project page:**
  - a **Logs** button;
  - a "Logs" link per component row (`?c=<id>`).
- **Retired:** `components/BuildLog.tsx` → `xxx_BuildLog.tsx` once nothing imports it.
  `LogViewer` (mock platform) is untouched.

### 9. Docs
- **README:**
  - architecture: a `backend/logs` box (:3005), the flow diagram above, and the log-proxy routes;
  - a **Terminal 6** run block (`cd backend/logs && npm install && npm run dev`);
  - a **Logs** section: build vs runtime, per-provider separation, what is stored and what is not,
    the limits and redaction;
  - env tables: `LOGS_SERVICE_URL`, `LOGS_SERVICE_TOKEN`, `LOGS_PROXY_TOKEN` (logs, Vercel and
    Render), `DATA_DIR`, `LEGACY_LOG_DIR`, `RENDER_RUNTIME_POLL_MS`, `RUNTIME_STREAM_MAX_MS`,
    `RUNTIME_IDLE_MS`, `MAX_STREAMS_PER_USER`, `MAX_LOG_BYTES`;
  - the test commands.
- **`backend/logs/README.md`:** its routes, storage layout, idempotent ingest, tailers, limits,
  and why it holds no provider tokens.
- **`frontend/docs/API_CONTRACT.md`:**
  - the `LogEntry` shape;
  - the reworked `/logs/stream` and `?format=entries`;
  - `/logs/download`;
  - the runtime routes, their events and ping;
  - `/logs` (index);
  - the error codes.
- **Service READMEs** (Vercel and Render: the log-proxy route and `LOGS_PROXY_TOKEN`);
  **`integration_common` README** (`ndjson`, `stream-limiter`, the log contract types).
- **`PLAN.md`:**
  - Phase 12 checklist, status and the service table;
  - the Phase 13 note: the combined log is read from `backend/logs` per deployment
    (`GET /deployments/:id/entries`), merged by `at`.
- **`PLAN_PHASE_12.md`:** a status header.

---

## Out of scope
- **A combined/merged log** across components or providers (Phase 13, for the AI only).
- Storing or searching runtime logs, log drains, alerts, metrics.
- Neon Postgres logs.
- Retention or cleanup of old log files (only the 20 MB per-file cap).
- Moving the existing build-log pull out of the integration deploy runners.
- Render's WebSocket subscribe (unless step 0 proves it; polling is the baseline).

## Verification
1. **Build hygiene:**
   - `logs`, `integration_common`, `vercel_integration`, `render_integration` and
     `neondb_integration`: `npx tsc --noEmit && npm test`;
   - `backend` and `frontend`: `npm run typecheck && npm run lint && npm test`;
   - `next build` for both, then restore `next-env.d.ts` if rewritten.

   Counts must be ≥ today's (backend 366, common 42, vercel 97, render 96, neondb 66, frontend 9),
   plus the new `logs` suite.
2. **Unit tests:**
   - the mappers (step 2), store (step 3), stream race and resume (step 4);
   - `RemoteLogWriter`:
     - batching;
     - `clientSeq`;
     - retry, then delivery;
     - overflow → one "lines lost" entry;
     - `close` with the service down → local tail;
     - redaction before send;
   - `applyEvents` tags (`source` = provider, and `at`, `stream`, `phase` kept);
   - Docker lines `docker`;
   - the proxy routes and token separation, tailers and session (step 6);
   - `RuntimeLogsService` redaction of a secret env value, Neon unsupported, another user's
     component → 404;
   - the logs index.
3. **Manual**, on `Vercel_Integration_test` (web on Vercel, api on Render, a Neon database; six
   terminals):
   - **Separation:** after Deploy all, `/deploy/<id>/logs` shows three tabs:
     - **web → Build** shows only `orbitops` + `vercel` badges;
     - **api → Build** shows only `orbitops` + `render`;
     - nothing leaks between tabs;
     - files exist under `backend/logs/data/<projectId>/`, and nothing new under
       `backend/data/logs/`.
   - **Errors:** break the start command and redeploy. The failing lines are tinted, and the count,
     ↑/↓ and "Errors only" work.
   - **Runtime:**
     - api: `curl` the backend; app lines appear within about 3 s; **Include requests** adds
       request lines; a logged secret env value is redacted;
     - web: a server function's log appears;
     - Neon: its note.
   - **Limits:** a 4th stream → "too many open streams". A tab hidden for 15 minutes → `end`, then
     **Resume** works.
   - **Logs service down:**
     - stop `backend/logs` mid-deploy: the deploy still finishes, and `logTail` is stored;
     - start it again: the buffered lines arrive, with no duplicates;
     - while it is down, the build page and runtime show "The logs service is not running".
   - **Proxy isolation:** `curl` a Vercel `/deployments` route with `LOGS_PROXY_TOKEN` → 401; and
     `/log-proxy/…` with the internal token → 401.
   - **Resilience:** restart the main backend mid-build. The page resumes from the last `seq`, with
     no duplicates.
   - **Copy and download:** the file is named per component and provider, and holds no secrets.
   - **Legacy:** a deployment from before Phase 12 (`backend/data/logs/*.log`) still opens.
   - **Second user:** every log route → 404.
