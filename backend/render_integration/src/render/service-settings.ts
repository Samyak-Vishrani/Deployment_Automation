import { createHash } from "node:crypto";
import { ProviderError } from "../http/provider-error";
import type { ComponentSpec, EnvVar, RepoSpec } from "../types";
import { renderRuntime, type RenderRuntime } from "./runtime-map";

export const REGIONS = ["oregon", "ohio", "virginia", "frankfurt", "singapore"] as const;
export const PLANS = ["free", "starter", "standard"] as const;
export type Region = (typeof REGIONS)[number];
export type Plan = (typeof PLANS)[number];

export interface ServiceDefaults {
  ownerId: string;
  region: string;
  plan: string;
}

/** A web service's settings, as Render's API spells them. */
export interface RenderServiceSettings {
  runtime: RenderRuntime;
  /** "" = repository root. */
  rootDir: string;
  branch: string;
  buildCommand: string | null;
  startCommand: string | null;
  healthCheckPath: string | null;
  region: string;
  plan: string;
  /** Docker runtime only. */
  dockerfilePath?: string;
  dockerContext?: string;
}

const clean = (value: string | null | undefined) => value?.trim() || null;

/**
 * Component + workspace defaults → Render settings.
 *
 * Render has a single build command, so install and build are joined. A
 * native runtime cannot run without a start command; a Docker service takes
 * both from its Dockerfile.
 */
export function toServiceSettings(
  component: ComponentSpec,
  repo: RepoSpec,
  defaults: Pick<ServiceDefaults, "region" | "plan">,
): RenderServiceSettings {
  const runtime = renderRuntime(component.framework);
  if (!runtime) {
    throw new ProviderError(
      `Render cannot tell how to run "${component.framework ?? "an unset framework"}". ` +
        "Set the component's framework (e.g. express, nestjs, fastapi) on the Configure screen.",
      400,
      "render_unknown_runtime",
    );
  }

  const rootDir = component.rootDir === "." ? "" : component.rootDir.replace(/^\.\/+/, "").replace(/\/+$/, "");
  const base = {
    runtime,
    rootDir,
    branch: repo.branch,
    healthCheckPath: clean(component.healthCheckPath),
    region: defaults.region,
    plan: defaults.plan,
  };

  if (runtime === "docker") {
    return {
      ...base,
      buildCommand: null,
      startCommand: null,
      dockerfilePath: rootDir ? `./${rootDir}/Dockerfile` : "./Dockerfile",
      dockerContext: rootDir ? `./${rootDir}` : ".",
    };
  }

  const startCommand = clean(component.startCmd);
  if (!startCommand) {
    throw new ProviderError(
      `${component.name} has no start command. Render needs one to run the service (e.g. "npm start").`,
      400,
      "render_missing_start",
    );
  }
  const buildCommand = [clean(component.installCmd), clean(component.buildCmd)].filter(Boolean).join(" && ") || null;
  return { ...base, buildCommand, startCommand };
}

/** The part of the settings that can be PATCHed. Runtime, region and plan are fixed at creation. */
function patchable(settings: RenderServiceSettings) {
  return {
    rootDir: settings.rootDir,
    branch: settings.branch,
    buildCommand: settings.buildCommand,
    startCommand: settings.startCommand,
    healthCheckPath: settings.healthCheckPath,
    dockerfilePath: settings.dockerfilePath ?? null,
    dockerContext: settings.dockerContext ?? null,
  };
}

export function settingsHash(settings: RenderServiceSettings): string {
  return createHash("sha256").update(JSON.stringify(patchable(settings))).digest("hex");
}

function envSpecificDetails(settings: RenderServiceSettings) {
  return settings.runtime === "docker"
    ? { dockerfilePath: settings.dockerfilePath, dockerContext: settings.dockerContext }
    : { buildCommand: settings.buildCommand ?? "", startCommand: settings.startCommand };
}

/** Body of POST /services. Auto-deploy is off: OrbitOps triggers every deploy. */
export function createServiceBody(
  name: string,
  ownerId: string,
  repo: RepoSpec,
  settings: RenderServiceSettings,
  envVars: EnvVar[],
) {
  return {
    type: "web_service",
    name,
    ownerId,
    repo: `https://github.com/${repo.fullName}`,
    branch: settings.branch,
    rootDir: settings.rootDir,
    autoDeployTrigger: "off",
    envVars,
    serviceDetails: {
      runtime: settings.runtime,
      plan: settings.plan,
      region: settings.region,
      numInstances: 1,
      ...(settings.healthCheckPath ? { healthCheckPath: settings.healthCheckPath } : {}),
      envSpecificDetails: envSpecificDetails(settings),
    },
  };
}

/** Body of PATCH /services/:id: only what may change after creation. */
export function patchServiceBody(settings: RenderServiceSettings) {
  return {
    branch: settings.branch,
    rootDir: settings.rootDir,
    autoDeployTrigger: "off",
    serviceDetails: {
      healthCheckPath: settings.healthCheckPath ?? "",
      envSpecificDetails: envSpecificDetails(settings),
    },
  };
}
