import type { ComponentKind, ProviderId } from "@prisma/client";

/**
 * The MVP rule: each kind of component goes to exactly one provider.
 *
 * Stored per component as data rather than derived from `kind` at deploy time,
 * so letting users pick another provider later means relaxing the validator and
 * widening the dropdown - not a migration.
 */
export const PROVIDER_FOR_KIND: Record<ComponentKind, ProviderId> = {
  frontend: "vercel",
  backend: "render",
  database: "neon",
};

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  vercel: "Vercel",
  render: "Render",
  neon: "Neon",
  local_docker: "Local Docker",
};

export const KIND_LABEL: Record<ComponentKind, string> = {
  frontend: "Frontend",
  backend: "Backend",
  database: "Database",
};

export const COMPONENT_KINDS: readonly ComponentKind[] = ["frontend", "backend", "database"];
export const PROVIDER_IDS: readonly ProviderId[] = ["vercel", "render", "neon", "local_docker"];

export function isAllowedProvider(kind: ComponentKind, provider: ProviderId): boolean {
  return PROVIDER_FOR_KIND[kind] === provider;
}

/**
 * Providers that can deploy today. Neon is configurable but waits for
 * Phase 8; pre-flight reports it as pending.
 */
export const CAN_DEPLOY: ReadonlySet<ProviderId> = new Set<ProviderId>(["vercel", "render", "local_docker"]);

/**
 * Frameworks Render can run, by runtime. A mirror of
 * backend/render_integration/src/render/runtime-map.ts, which is the source of
 * truth at deploy time; pre-flight uses this copy to warn before a deploy.
 */
export const RENDER_FRAMEWORKS: ReadonlySet<string> = new Set([
  "nestjs", "express", "fastify", "hono", "koa", "node", "nodejs",
  "fastapi", "flask", "django", "python",
  "go", "gin", "fiber",
  "rails", "ruby",
  "rust", "actix", "axum", "rocket",
  "docker",
]);

/** The PLAN.md phase that brings each provider, for "arrives in Phase N" messages. */
export const PROVIDER_PHASE: Record<ProviderId, number> = {
  vercel: 6,
  render: 7,
  neon: 8,
  local_docker: 3,
};
