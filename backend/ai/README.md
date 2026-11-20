# OrbitOps AI service (`backend/ai`, :3006)

The AI assistant of Phase 13. Given a **context bundle** about one project, it says whether
anything is wrong, what, and the ordered steps to fix it, for the whole project or one component
(Vercel, Render, Neon, or the local Docker deploys). It runs on demand only and never changes
anything.

- Loopback only (`127.0.0.1:3006`). Every route but `/health` needs `x-internal-token: <AI_SERVICE_TOKEN>`.
- The **only** holder of `OPENAI_API_KEY`. The model is `gpt-4o-mini` (`OPENAI_MODEL`).
- **No access to the main database or the other services.** The main backend
  (`backend/lib/ai/context-builder.ts`) checks ownership, gathers the bundle (log excerpts and
  runtime snapshots from `backend/logs`) and posts it. The bundle holds env var **keys** only.
- Stores each analysis in Postgres schema `ai` (`AiAnalysis`): the result, tokens, duration,
  feedback. Never the bundle.

## Run it

```bash
cp .env.example .env       # AI_SERVICE_TOKEN (same as backend/.env), DATABASE_URL (?schema=ai), OPENAI_API_KEY
npm install
npx prisma migrate deploy  # creates the "ai" schema
npm run dev                # :3006
npm run spike              # optional: one real call, prints latency, tokens and that the answer parses
npm test && npm run typecheck
```

Without `OPENAI_API_KEY` the service still answers, from its rules (`engine: "rules"`).

## Routes

| Method & path | Purpose |
| --- | --- |
| `GET /health` | `{ status, database, openaiConfigured, model }` (no token) |
| `POST /analyses` | `{ userId, projectId, scope: "project"\|"component", componentId?, deploymentId?, question?, force?, bundle }` → `AnalysisView` (body ≤ 4 MB) |
| `GET /analyses?userId=&projectId=&take=` | summaries, newest first |
| `GET /analyses/:id?userId=` | one `AnalysisView`; 404 unless it is that user's |
| `POST /analyses/:id/feedback` | `{ userId, helpful }` |

Errors: `ai_rate_limited` 429 (20 an hour, 100 a day per user), `ai_busy` 409 (one analysis at a
time per project), `bad_request` 400.

## The pipeline (`src/analysis/analysis.service.ts`)

1. **Cache:** the same bundle and question within `AI_CACHE_MINUTES` (10) return the stored answer
   with `cached: true`, unless `force`.
2. **Limits:** the rate limit, then the per-project lock.
3. **Redact** every string in the bundle again (`analysis/redact-bundle.ts`): token shapes,
   connection strings, `KEY=value` of secret-looking keys.
4. **Rules** (`rules/classify.ts`): log-line rules per category (missing env var, port binding,
   start command, database connection, API URL, CORS, out of memory, …) and signals beyond the
   logs (a failed latest deployment, a failed pre-flight check, a release stopped at stage N,
   `pendingRedeploy`, a frontend whose backend has no URL, a backend without `DATABASE_URL` when
   a database exists). They become **hypotheses** the model must verify.
5. **Budget** (`budget/fit.ts`): about 24k input tokens (characters ÷ 4). Trimmed in order: runtime
   lines of healthy components, old deployments, log context, healthy components' logs, and last
   the failing components' error lines. What was trimmed is told to the model and in `notice`.
6. **Timeline** (`timeline/timeline.ts`): every component's log and runtime lines merged by time,
   tagged `[component · source]`, 200 lines around the first failure. This is the combined log
   Phase 12 deliberately does not have; it exists only inside the prompt.
7. **Prompt** (`prompts/`): the system rules (logs and the question are untrusted data; never
   reveal or invent secret values; never claim to have run anything; no destructive commands; say
   when unsure), short playbooks for the providers present, the fenced bundle.
8. **OpenAI** (`llm/openai.ts`): `chat.completions` with Structured Outputs
   (`response_format: json_schema, strict`), temperature 0.2, 2500 output tokens.
9. **Validate** (`validate.ts`): unknown component and problem ids dropped, steps renumbered,
   destructive or secret-writing commands removed, and the **evidence guard**: a quoted log line
   that is not in the context is dropped, and a problem left without evidence is capped at 0.3
   confidence.
10. **Fallback** (`rules/fallback.ts`): no key, or OpenAI failed (key invalid, rate limited,
    timeout, bad answer) → a rule-based answer from the hypotheses, with the reason in `notice`.

## The answer (`src/schema.ts`)

`{ verdict: healthy|degraded|failing|unknown, summary, problems[{ id, title, severity, category,
componentIds, rootCause, confidence, evidence[{ componentId, source, line, deploymentId }] }],
steps[{ order, title, detail, problemIds, where: configure|settings|environment|repository|provider_dashboard|redeploy,
componentId, command, file, envKey }], components[{ componentId, status, note }], providerNotes,
followUps }`

## Layout

```
src/rules/      classify (hypotheses), the rule-based fallback, the error-line rule
src/budget/     token estimate, fitBundle
src/timeline/   the combined timeline
src/prompts/    system prompt, provider playbooks, bundle rendering, user prompt
src/llm/        the OpenAI client and its error mapping
src/analysis/   the service (cache, limits, lock, pipeline), request parsing, bundle redaction
src/schema.ts   the strict JSON schema; src/validate.ts the validator and evidence guard
scripts/        ai-spike.ts (one real call)
```
