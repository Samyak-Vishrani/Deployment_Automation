# @orbitops/integration-common

Plumbing shared by the provider integration services:
- `backend/vercel_integration` (:3002);
- `backend/render_integration` (:3003);
- `backend/neondb_integration` (:3004);
- `backend/logs` (:3005, Phase 12).

It is a library, not a process. It holds TypeScript source only, with no build step: each
service runs it through `tsx` (dev and start), `tsc --noEmit` (typecheck) and Vitest (tests).

| Import | What it is |
|---|---|
| `@orbitops/integration-common/internal-auth` | constant-time check of the `x-internal-token` the main backend sends |
| `@orbitops/integration-common/secret-box` | `createSecretBox({ devFallbackSeed })` → `{ seal, open }`, AES-256-GCM with the service's `ENCRYPTION_KEY` |
| `@orbitops/integration-common/redact` | masks secrets in text before it is logged |
| `@orbitops/integration-common/provider-fetch` | `fetch` with timeout, retries, backoff and `retry-after` / `ratelimit-reset` / `x-ratelimit-reset` |
| `@orbitops/integration-common/provider-error` | `ProviderError`, `ServiceError`, `badRequest` / `notFound` / `conflict` |
| `@orbitops/integration-common/contract` | `NormalisedStatus`, `LogLine`, `EnvVar`, `ProviderEvent`, `EventBatch`: the event contract with the main backend. Since Phase 12 also `EventLogLine` (`origin`, `phase`), `LogEntry`, `RuntimeLogLine`, `RuntimeLogEvent` |
| `@orbitops/integration-common/callback-client` | signed POSTs to `/api/internal/provider-events`, with `x-orbitops-provider` |
| `@orbitops/integration-common/outbox` | ordered, persisted, retried delivery of event batches, over a `PendingEventStore` the service implements on its own table |
| `@orbitops/integration-common/deploy-queue` | per-component FIFO with a global concurrency cap |
| `@orbitops/integration-common/env-vault` | `EnvVault`: deploy-time env values held in memory until the run takes them, never at rest (Render and Vercel, Phase 9) |
| `@orbitops/integration-common/ndjson` | `readNdjson` (parsed lines of a streamed body, split chunks joined) and `pipeNdjson` (NDJSON out with heartbeats, stopped when the client leaves); Phase 12 |
| `@orbitops/integration-common/stream-limiter` | `StreamLimiter(n)`: at most n open streams per key (user); Phase 12 |
| `@orbitops/integration-common/env-hash` | `envHash` (unchanged set = no provider calls; a `secret` flag counts) and `keysToDelete` (managed keys no longer wanted) |
| `@orbitops/integration-common/config-helpers` | `requireEnv`, `requireSecretLength`, `positiveInt`, `baseUrl`, `MissingEnvError` |

## How a service uses it

`package.json`:
```json
"dependencies": { "@orbitops/integration-common": "file:../integration_common" }
```

`npm install` inside the service links this folder into `node_modules/@orbitops/integration-common`
(a junction on Windows). Tools follow the link to the real path, outside `node_modules`, so `tsx`
and Vitest transform the `.ts` files like the service's own.

Rules:
- **No runtime dependencies.** Nothing here imports Prisma, Fastify or the backend. Anything that
  touches a service's tables goes through an interface the service implements, as `outbox.ts`
  does with `PendingEventStore`.
- **No service-specific names.** A provider's name comes in as a parameter, as in
  `new CallbackClient(url, secret, "render")` and `createSecretBox({ devFallbackSeed })`.
- **Keep each service's `devFallbackSeed` unchanged**, or values it already sealed with the
  development key stop opening.

## Test

```bash
npm install
npm run typecheck
npm test
```
