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
