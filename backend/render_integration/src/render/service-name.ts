import { randomBytes } from "node:crypto";

const MAX_LENGTH = 60;

/**
 * A Render service name for a component: lowercase letters, digits and single
 * dashes. Render derives the *.onrender.com hostname from it, so it is kept
 * readable: `<repo>-<component>`.
 */
export function renderServiceName(repoFullName: string, componentName: string, suffix = ""): string {
  const repo = repoFullName.split("/").pop() ?? repoFullName;
  const parts = [repo, componentName]
    .map(slug)
    .filter(Boolean)
    // "api" inside a repo already called "api" would read "api-api".
    .filter((part, index, all) => index === 0 || part !== all[0]);
  const base = parts.join("-") || "service";
  const tail = suffix ? `-${slug(suffix)}` : "";
  return `${base.slice(0, MAX_LENGTH - tail.length).replace(/-+$/, "")}${tail}`;
}

/** Four random lowercase characters, for retrying after a name collision. */
export function randomSuffix(): string {
  return randomBytes(4)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "x")
    .slice(0, 4);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}
