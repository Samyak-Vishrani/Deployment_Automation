# OrbitOps logs service (`backend/logs`, :3005)

Phase 12. One service for logs as a whole:

- every deployment's **build log**, stored as JSONL;
- reading it, in pages, as text, or as a live stream;
- the **runtime logs** of a running component (Render app logs, Vercel function logs, the local
  Docker container), tailed live and never stored.

It is a Fastify process with no database. It listens on `127.0.0.1` only, and its one client is
the main backend, which checks that the user owns the deployment or component before it calls.

Every route is about **one** deployment or **one** component. Nothing here merges the logs of
several. The combined, time-ordered log is Phase 13's (the AI assistant), built by reading each
deployment's entries and merging them by `at`.

## Run it

```bash
cp .env.example .env     # set LOGS_SERVICE_TOKEN and LOGS_PROXY_TOKEN (see the main README, "Logs")
npm install              # links ../integration_common
npm run dev              # :3005
npm test
```

## Storage

```
data/<projectId>/<deploymentId>.jsonl       one LogEntry per line
data/<projectId>/<deploymentId>.meta.json   { componentId, provider, nextSeq, lastClientSeq, bytes, truncated, status, closedAt }
```

**What each entry holds.** `LogEntry = { seq, at, source, phase, stream, text }`:
- `source`: `orbitops` | `vercel` | `render` | `neon` | `docker`;
- `phase`: `setup` | `build` | `deploy` | `runtime`;
- `stream`: `info` | `stdout` | `stderr`.

**Writing:**
- **`seq`** is assigned here: gap-free per deployment, and the SSE id the browser resumes from.
- **Idempotent ingest:** the backend numbers what it sends (`clientSeq`), and entries at or below
  `lastClientSeq` are dropped, so a retried batch never duplicates.
- **Serialised:** appends to one deployment queue behind each other, so `seq` stays in order.
- **Cleaned:** ANSI colour codes are stripped. Token shapes are redacted again as a backstop (the
  backend already redacted with the deployment's own secrets). Lines are cut at 16 KB.
- **Capped:** at 20 MB (`MAX_LOG_BYTES`) one "Log truncated" entry is written, and later lines are
  dropped.

**Reading:**
- **Legacy:** a deployment from before Phase 12 has a plain `.log` file in the backend's old data
  folder. It is read, read-only, from `LEGACY_LOG_DIR`.

## Routes

All routes except `/health` need `x-internal-token: <LOGS_SERVICE_TOKEN>`.

| Method & path | Purpose |
| --- | --- |
| `GET /health` | liveness |
| `POST /deployments/:id/entries` | `{ projectId, componentId, provider, clientSeq, entries: [{ text, at?, source, phase, stream }] }` (≤ 500) → `{ nextSeq, accepted }` |
| `POST /deployments/:id/close` | `{ projectId, status }` → `{ tail }` (the last 64 KB as text, for `Deployment.logTail`) |
| `GET /deployments/:id/entries?projectId=&afterSeq=&limit=` | `{ entries, nextSeq, complete, status, truncated, legacy }` (limit ≤ 5000) |
| `GET /deployments/:id/text?projectId=` | the whole log as text, `[12:03:04] [render] text` per line |
| `GET /deployments/:id/stream?projectId=&afterSeq=` | NDJSON `{type:"entry",entry}`… then `{type:"done",status}`, plus heartbeats |
| `GET /runtime/components/:componentId/stream?userId=&provider=vercel\|render&since=5m\|15m\|1h&requests=0\|1` | NDJSON `RuntimeLogEvent`s; the session id is in `x-session-id` |
| `GET /runtime/docker/:containerName/stream?userId=&since=` | the same, for `orbitops-<slug>` |
| `POST /runtime/sessions/:sessionId/ping` | the viewer is still watching (resets the idle timer) |
| `GET /deployments/:id/excerpt?projectId=&maxLines=400` | Phase 13, for the AI: the **errors-first** excerpt `{ entries, totalLines, errorLines, truncated, status }` (see below; `maxLines` ≤ 1500) |
| `GET /runtime/components/:componentId/snapshot?userId=&provider=render\|vercel&since=&limit=100` | Phase 13: the recent runtime lines, read **once** `{ lines, note }`. Render: one newest-first page; Vercel: no lines, a note (it keeps no history) |
| `GET /runtime/docker/:containerName/snapshot?since=&limit=100` | the same for the Docker container (`docker logs --tail`) |

**The build stream is race-free:**
1. it subscribes first;
2. then replays from `afterSeq`;
3. then passes on only the live entries past the last replayed `seq`.

A line written during the replay is delivered exactly once.

**The excerpt** (`src/entries/excerpt.ts`) keeps every error line with 5 lines either side, the
first 20 and the last 150 lines, in `seq` order; runs of identical lines become one entry with
`repeat: n`. When that is still over `maxLines` it narrows (2 lines of context, first 10, last
60), and then to the error lines alone. Snapshots open no session and do not count against the
3-stream limit.

## Runtime logs

This service holds **no provider credentials**. It calls the integration services' read-only
**log-proxy** routes with `LOGS_PROXY_TOKEN` (header `x-logs-token`). Those routes accept only that
token, the token opens nothing else, and they add the user's Vercel token or Render key
themselves.

| Provider | How it is tailed (measured against the real APIs, 2026-11-04) |
| --- | --- |
| Render | `GET /v1/logs` pages through `render_integration` (see below) |
| Vercel | one long read of the runtime-logs stream through `vercel_integration` (see below) |
| Local Docker | `docker logs --follow --timestamps --since …`, killed when the viewer leaves |
| Neon | none: Neon has no runtime log API (the backend answers `runtime_logs_unsupported`) |

**Render:**
- On open, a backfill of the newest 100 lines (`direction=backward`).
- Then a forward poll every 3 s, de-duplicated by log id.
- Render allows **30 reads a minute** (`ratelimit-limit: 30`), so when the quota is nearly spent
  the next read waits for the reset. A 429 slows down.
- Transient failures are retried, and 5 in a row end the stream.

**Vercel:**
- Vercel sends **nothing, not even headers, until there is a log line**, and static pages never
  log at runtime. So "connected" is reported without waiting.
- A refusal within 3 s (not deployed, token rejected) is still an HTTP error.
- When Vercel closes the stream, it reconnects quietly.

**Sessions** (`runtime/runtime-session.ts`):
- at most 3 open streams per user (409 `runtime_logs_busy`);
- a stream ends `idle` after 15 minutes without a ping, or `max_duration` after 60 minutes;
- the tailer's first event is awaited before streaming, so a refusal is a normal JSON error;
- every line passes the generic redaction.

## Layout

```
src/entries/    the entry shapes as text, the legacy .log parser, the error rule (copied to the frontend), ANSI stripping
src/store/      LogStore: JSONL files, meta, seq, ingest dedupe, bus for live readers
src/routes/     the race-free build stream; the runtime routes
src/providers/  Render and Vercel runtime-line mappers (+ fixtures)
src/runtime/    proxy client, Render / Vercel / Docker tailers, sessions
```
