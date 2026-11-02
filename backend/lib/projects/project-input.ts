import { badRequest } from "@/lib/api/http-error";

/**
 * Request-body validation for the project endpoints.
 *
 * The NestJS original expressed these as class-validator DTOs behind a global
 * ValidationPipe with `whitelist` and `forbidNonWhitelisted`. There is no such
 * pipe in a Next.js route handler, and decorators would drag in
 * reflect-metadata and an emitDecoratorMetadata tsconfig for two objects - so
 * the same rules are written out, with the same rejection of unknown keys.
 */

export interface CreateProjectInput {
  repoUrl: string;
  name?: string;
  slug?: string;
  branch?: string;
  autoDeploy?: boolean;
  watchPaths?: string[];
  dockerfilePath?: string;
  buildContext?: string;
  envVars?: Record<string, string>;
  containerPort?: number;
}

export interface UpdateProjectInput {
  branch?: string;
  autoDeploy?: boolean;
  watchPaths?: string[];
  dockerfilePath?: string;
  buildContext?: string;
  envVars?: Record<string, string>;
  containerPort?: number;
}

const CREATE_KEYS = [
  "repoUrl",
  "name",
  "slug",
  "branch",
  "autoDeploy",
  "watchPaths",
  "dockerfilePath",
  "buildContext",
  "envVars",
  "containerPort",
] as const;

/**
 * Deliberately not the create keys minus one: `repoUrl` must not be editable.
 * Repointing an existing project at a different repository would silently
 * change what its running container serves while keeping its history, its port
 * and its name. Delete and recreate instead.
 */
const UPDATE_KEYS = [
  "branch",
  "autoDeploy",
  "watchPaths",
  "dockerfilePath",
  "buildContext",
  "envVars",
  "containerPort",
] as const;

/** Lowercase, digits and dashes, starting with a letter or digit. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw badRequest(`Unexpected field(s): ${unknown.join(", ")}.`);
  }
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${key} must be a string.`);
  if (value.length > maxLength) {
    throw badRequest(`${key} must be at most ${maxLength} characters.`);
  }
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest(`${key} must be true or false.`);
  return value;
}

function optionalStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw badRequest(`${key} must be an array of strings.`);
  }
  return value as string[];
}

function optionalEnvVars(
  body: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${key} must be an object of string values.`);
  }
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw badRequest(`${key}.${name} must be a string.`);
    }
  }
  return value as Record<string, string>;
}

function optionalPort(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  // Numeric strings are accepted because an HTML number input submits one; the
  // NestJS original did the same with @Type(() => Number).
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw badRequest(`${key} must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function optionalSlug(body: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(body, key, 50);
  if (value === undefined) return undefined;
  if (value !== "" && !SLUG_PATTERN.test(value)) {
    throw badRequest(
      `${key} must be lowercase letters, digits and dashes, and start with a letter or digit.`,
    );
  }
  return value;
}

export function parseCreateProject(body: unknown): CreateProjectInput {
  const raw = asObject(body);
  rejectUnknownKeys(raw, CREATE_KEYS);

  const repoUrl = optionalString(raw, "repoUrl", 300);
  if (!repoUrl || repoUrl.trim() === "") {
    throw badRequest("repoUrl is required.");
  }

  return {
    repoUrl,
    name: optionalString(raw, "name", 120),
    slug: optionalSlug(raw, "slug"),
    branch: optionalString(raw, "branch", 255),
    autoDeploy: optionalBoolean(raw, "autoDeploy"),
    watchPaths: optionalStringArray(raw, "watchPaths"),
    dockerfilePath: optionalString(raw, "dockerfilePath", 255),
    buildContext: optionalString(raw, "buildContext", 255),
    envVars: optionalEnvVars(raw, "envVars"),
    containerPort: optionalPort(raw, "containerPort"),
  };
}

export function parseUpdateProject(body: unknown): UpdateProjectInput {
  const raw = asObject(body);
  rejectUnknownKeys(raw, UPDATE_KEYS);

  return {
    branch: optionalString(raw, "branch", 255),
    autoDeploy: optionalBoolean(raw, "autoDeploy"),
    watchPaths: optionalStringArray(raw, "watchPaths"),
    dockerfilePath: optionalString(raw, "dockerfilePath", 255),
    buildContext: optionalString(raw, "buildContext", 255),
    envVars: optionalEnvVars(raw, "envVars"),
    containerPort: optionalPort(raw, "containerPort"),
  };
}
