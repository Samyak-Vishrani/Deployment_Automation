# OrbitOps frontend

OrbitOps is a frontend-first prototype for an AI-assisted internal developer platform. It gives a team one view of repository onboarding, CI/CD progress, deployment history, health signals, secrets metadata, databases, and AI-assisted release diagnosis.

## Run locally

The project uses Next.js, TypeScript, and the App Router.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000` and use the demo account:

- Email: `demo@orbitops.dev`
- Password: `orbitops`

The default data mode is `mock`. The mock provider persists project changes in browser local storage and simulates pipeline transitions from `queued` to `running` to `succeeded`. Use **Demo failure** to inspect the failure logs and AI diagnosis experience.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Dependency installation and verification require access to the npm registry. If the local runtime blocks that access, run the commands on a machine with registry access.

## Frontend-to-backend handoff

Pages use the `PlatformProvider` interface in `lib/platform/types.ts`. `MockPlatformProvider` is the default implementation. Set `NEXT_PUBLIC_DATA_MODE=api` to select `HttpPlatformProvider` once the NestJS API is available.

The API provider expects the following route families:

- `/auth/login`, `/auth/me`, `/auth/logout`
- `/projects`, `/projects/:projectId`
- `/projects/:projectId/pipeline-runs`, `/pipeline-runs/:runId`
- `/pipeline-runs/:runId/logs`
- `/projects/:projectId/deployments`, `/deployments/:deploymentId`
- `/deployments/:deploymentId/health`
- `/projects/:projectId/ai-insights`

Authentication is deliberately cookie-based. The local auth route creates a development-only signed JWT-shaped cookie. The production backend should replace it with a short-lived, backend-issued JWT in an HttpOnly, Secure, SameSite cookie and keep raw tokens out of browser JavaScript.

## Demo journey

1. Sign in.
2. Open **New project** and complete the four onboarding steps.
3. Open the project dashboard.
4. Run a successful pipeline or start a failure simulation.
5. Follow the pipeline stages and output.
6. Open deployments, observability, secrets, or databases from the project navigation.

The first production integration should support one known Node.js or Next.js sample repository, GitHub Actions for CI and image publishing, and a local Kind cluster for deployment. Generalized repository detection, automatic infrastructure generation, production secret storage, and autonomous remediation remain later milestones.
