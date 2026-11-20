import type { Component } from "@prisma/client";
import { apiUrlKey } from "@/lib/providers/api-url-env";

/** The env vars a Neon database gives a Render backend (Phase 8). */
export const DATABASE_ENV_KEYS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const;

/**
 * A variable OrbitOps sets itself at deploy time. Only the KEY lives here: the
 * values (connection strings, the backend URL) are fetched per deploy and
 * never stored.
 *
 * - `neon`: DATABASE_URL / DATABASE_URL_UNPOOLED. These beat a user value of
 *   the same name (Phase 8).
 * - `backend`: the frontend's API URL key. A user value of the same name beats
 *   it, which is how a project with several backends sets its own.
 */
export type SystemEnvKey = {
  key: string;
  source: "neon" | "backend";
  /** The component it comes from. */
  from: string;
  /** Whether a user value of the same key is used instead. */
  userWins: boolean;
};

type Sibling = Pick<Component, "kind" | "provider" | "name">;

/**
 * The system keys a component will be deployed with, worked out from the
 * project's other components. The one source for the editor, pre-flight and
 * the deploy path.
 */
export function systemEnvKeys(
  component: Pick<Component, "id" | "kind" | "provider" | "framework" | "buildCmd">,
  siblings: (Sibling & { id: string })[],
): SystemEnvKey[] {
  const others = siblings.filter((s) => s.id !== component.id);

  if (component.kind === "backend" && component.provider === "render") {
    const database = others.find((s) => s.kind === "database" && s.provider === "neon");
    if (!database) return [];
    return DATABASE_ENV_KEYS.map((key) => ({ key, source: "neon", from: database.name, userWins: false }));
  }

  if (component.kind === "frontend" && component.provider === "vercel") {
    const backends = others.filter((s) => s.kind === "backend");
    if (backends.length !== 1) return [];
    return [
      { key: apiUrlKey(component.framework, component.buildCmd), source: "backend", from: backends[0].name, userWins: true },
    ];
  }

  return [];
}
