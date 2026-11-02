import { randomBytes } from "node:crypto";

const MAX_LENGTH = 100;

/**
 * A Vercel project name for a component: lowercase letters, digits and single
 * dashes, at most 100 characters. It also becomes the production hostname
 * (`<name>.vercel.app`), so it is kept readable: `<repo>-<component>`.
 */
export function vercelProjectName(repoFullName: string, componentName: string, suffix = ""): string {
  const repo = repoFullName.split("/").pop() ?? repoFullName;
  const parts = [repo, componentName]
    .map(slug)
    .filter(Boolean)
    // "web" inside a repo already called "web" would read "web-web".
    .filter((part, index, all) => index === 0 || part !== all[0]);
  const base = parts.join("-") || "app";
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
