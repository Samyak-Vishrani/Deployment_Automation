/**
 * Our framework ids (backend/lib/analysis/build-settings.ts and the configure
 * screen) → the Render runtime that builds and runs them.
 *
 * null means Render cannot tell: pre-flight asks the user to set the framework.
 */

export type RenderRuntime = "node" | "python" | "go" | "ruby" | "rust" | "docker";

const RUNTIMES: Record<string, RenderRuntime> = {
  nestjs: "node",
  express: "node",
  fastify: "node",
  hono: "node",
  koa: "node",
  node: "node",
  nodejs: "node",
  fastapi: "python",
  flask: "python",
  django: "python",
  python: "python",
  go: "go",
  gin: "go",
  fiber: "go",
  rails: "ruby",
  ruby: "ruby",
  rust: "rust",
  actix: "rust",
  axum: "rust",
  rocket: "rust",
  docker: "docker",
};

export function renderRuntime(framework: string | null | undefined): RenderRuntime | null {
  const id = framework?.trim().toLowerCase();
  return id ? (RUNTIMES[id] ?? null) : null;
}

export const SUPPORTED_FRAMEWORKS = Object.keys(RUNTIMES);
