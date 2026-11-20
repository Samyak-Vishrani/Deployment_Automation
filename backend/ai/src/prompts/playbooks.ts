import type { Provider } from "../types";

/**
 * What commonly goes wrong on each provider, and how OrbitOps wires it. Only
 * the playbooks of the providers in the project are sent.
 */
export const PLAYBOOKS: Record<Provider, string> = {
  vercel: `VERCEL (frontends):
- OrbitOps creates one Vercel project per frontend component, building the component's folder (rootDir) with its framework, install, build and output settings.
- Build errors appear in the build log; runtime errors only come from server code (API routes, server components, middleware). Static pages never log at runtime.
- Browser-exposed variables (NEXT_PUBLIC_*, VITE_*, REACT_APP_*, PUBLIC_*) are inlined AT BUILD TIME: changing one needs a redeploy. Secrets must not use those prefixes.
- OrbitOps sets the backend's URL under the framework's public key (e.g. NEXT_PUBLIC_API_URL) when the project has exactly one backend with a URL; deploying the frontend before the backend has a URL leaves it unset (Deploy all deploys in order).
- Common causes: wrong rootDir or outputDir, a missing dependency, TypeScript or ESLint errors failing "next build", a missing env var at build time, calling the backend with a hard-coded localhost URL.`,
  render: `RENDER (backends):
- OrbitOps creates one Render web service per backend component, building its folder with the build command and running the start command.
- The server MUST listen on process.env.PORT and host 0.0.0.0; otherwise Render reports "No open ports detected" and the deploy fails.
- If a health check path is set, it must answer 200 or the deploy never goes live.
- Free instances sleep when idle; the first request after sleeping takes up to a minute (not an error).
- The start command must run the built output (e.g. node dist/index.js after a TypeScript build); "Cannot find module" at start usually means a wrong start command or a missing build step.
- Env vars are sent on each deploy; the project's shared env vars plus the backend's own; DATABASE_URL and DATABASE_URL_UNPOOLED come from Neon when the project has a database.`,
  neon: `NEON (Postgres):
- OrbitOps provisions one Neon project per database component and gives the backend DATABASE_URL (pooled, for the app) and DATABASE_URL_UNPOOLED (direct, for migrations). They override any value the user set.
- Migrations are NOT run by OrbitOps: they belong in the backend's build command (e.g. "npm install && npx prisma migrate deploy"); with Prisma, directUrl = env("DATABASE_URL_UNPOOLED"). "relation does not exist" / Prisma P2021 means migrations did not run.
- Connections need SSL (sslmode=require). Free computes suspend when idle; the first query after a pause is slow.
- Neon has no runtime log API: diagnose the database through the backend's logs.`,
  local_docker: `LOCAL DOCKER:
- OrbitOps builds the repository's Dockerfile and runs one container per project (orbitops-<slug>), publishing containerPort on a host port on 127.0.0.1.
- The app inside must listen on the configured container port (and EXPOSE it); a mismatch makes the health check fail.
- Env vars are passed at RUNTIME only, never as build args: code that needs a value during "docker build" will not have it.
- docker build writes its progress to stderr; that alone is not an error.`,
};

export function playbooksFor(providers: Provider[]): string {
  return [...new Set(providers)].map((p) => PLAYBOOKS[p]).join("\n\n");
}
