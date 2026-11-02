import { createHash } from "node:crypto";
import type { ComponentSpec } from "../types";
import { BUILDER_OWNS_OUTPUT, vercelFramework } from "./framework-map";

/** Build settings as Vercel's project API spells them. null = "use Vercel's default". */
export interface VercelProjectSettings {
  framework: string | null;
  rootDirectory: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  nodeVersion: string | null;
}

/** Node majors Vercel builds with. Anything else is left to Vercel's default. */
const SUPPORTED_NODE_MAJORS = new Set([18, 20, 22, 24]);

export function vercelNodeVersion(nodeVersion: string | null): string | null {
  const match = /(\d+)/.exec(nodeVersion ?? "");
  if (!match) return null;
  const major = Number(match[1]);
  return SUPPORTED_NODE_MAJORS.has(major) ? `${major}.x` : null;
}

const clean = (value: string | null | undefined) => value?.trim() || null;

export function toProjectSettings(component: ComponentSpec): VercelProjectSettings {
  const framework = vercelFramework(component.framework, component.outputDir);
  const rootDir = clean(component.rootDir);
  return {
    framework,
    rootDirectory: !rootDir || rootDir === "." ? null : rootDir.replace(/^\.\/+/, "").replace(/\/+$/, ""),
    installCommand: clean(component.installCmd),
    buildCommand: clean(component.buildCmd),
    // Next.js, Nuxt, SvelteKit and Remix builders decide their own output;
    // telling Vercel ".next" makes it look for static files that are not there.
    outputDirectory: framework && BUILDER_OWNS_OUTPUT.has(framework) ? null : clean(component.outputDir),
    nodeVersion: vercelNodeVersion(component.nodeVersion),
  };
}

/** Stable hash of the settings, so an unchanged component skips the PATCH. */
export function settingsHash(settings: VercelProjectSettings): string {
  const ordered = Object.keys(settings)
    .sort()
    .map((key) => [key, settings[key as keyof VercelProjectSettings]]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
