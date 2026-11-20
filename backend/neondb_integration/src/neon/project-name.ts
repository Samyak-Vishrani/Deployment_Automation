import { randomBytes } from "node:crypto";

const MAX = 64;

/**
 * The Neon project name for a database component: `<project>-<component>`,
 * lowercase letters, digits and dashes, at most 64 characters. `suffix`
 * (four random characters by default) is added on a name conflict.
 *
 * "Vercel_Integration_test" + "database" → "vercel-integration-test-database".
 */
export function neonProjectName(projectName: string, componentName: string, suffix?: string | true): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const project = slug(projectName);
  const component = slug(componentName);
  let base = [project, component].filter(Boolean).join("-") || "orbitops-database";
  // "shop" + "shop-db" should not read "shop-shop-db".
  if (component && project && component.startsWith(`${project}-`)) base = component;

  const tail = suffix === undefined ? "" : `-${suffix === true ? randomBytes(2).toString("hex") : slug(suffix)}`;
  return `${base.slice(0, MAX - tail.length).replace(/-+$/, "")}${tail}`;
}
