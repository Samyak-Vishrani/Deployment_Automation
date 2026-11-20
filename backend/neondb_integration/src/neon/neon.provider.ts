import { ProviderError } from "@orbitops/integration-common/provider-error";
import { abortableSleep } from "@orbitops/integration-common/provider-fetch";
import type { NeonOrg } from "../types";
import { isPostgresUri } from "./connection";
import { expectOk, neonError, neonRequest, type NeonContext } from "./neon-http";
import { allFinished, asOperations, describeFailure, firstFailure } from "./operations";
import { neonProjectName } from "./project-name";

export interface AccountInfo {
  /** Name or email, for Settings. */
  accountName: string;
  orgs: NeonOrg[];
}

export interface ProjectSpec {
  name: string;
  regionId: string;
  pgVersion: number;
  /** null: let Neon use the key's default. */
  orgId: string | null;
}

/** What is stored about a project: everything needed to ask for its connection strings. */
export interface ProjectInfo {
  neonProjectId: string;
  name: string;
  regionId: string;
  pgVersion: number;
  orgId: string | null;
  branchId: string;
  databaseName: string;
  roleName: string;
  host: string | null;
}

export interface DatabaseRef {
  neonProjectId: string;
  branchId: string;
  databaseName: string;
  roleName: string;
}

export interface NeonProviderOptions {
  pollIntervalMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

interface CreateResponse {
  project?: { id?: string; name?: string; region_id?: string; pg_version?: number; org_id?: string | null };
  branch?: { id?: string };
  databases?: Array<{ name?: string; owner_name?: string; branch_id?: string }>;
  roles?: Array<{ name?: string; protected?: boolean }>;
  endpoints?: Array<{ host?: string }>;
  connection_uris?: Array<{ connection_parameters?: { database?: string; role?: string; host?: string } }>;
  operations?: unknown;
}

/**
 * Everything this service asks of the Neon API (https://api-docs.neon.tech).
 * No state of its own: callers pass the key and persist what comes back.
 */
export class NeonProvider {
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(options: NeonProviderOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------- credentials --

  /**
   * Checks the key and lists the organizations it can see. A personal key
   * answers GET /users/me. An organization key may not (step 0 confirms), so
   * any answer but 401 there falls back to listing projects, which every
   * valid key can do.
   */
  async validateKey(apiKey: string): Promise<AccountInfo> {
    const ctx: NeonContext = { apiKey };
    const me = await neonRequest<{ name?: string; last_name?: string; email?: string; login?: string }>(
      ctx,
      "GET",
      "/users/me",
    );
    if (me.status === 401) throw neonError(me, "checking the API key", [apiKey]);

    let accountName = "Neon account";
    if (me.status >= 200 && me.status < 300) {
      const fullName = [me.body?.name, me.body?.last_name].filter(Boolean).join(" ").trim();
      accountName = fullName || me.body?.email || me.body?.login || accountName;
    } else {
      expectOk(await neonRequest(ctx, "GET", "/projects", { query: { limit: 1 } }), "checking the API key", [apiKey]);
      accountName = "Neon organization key";
    }

    const orgsResponse = await neonRequest<{ organizations?: Array<{ id?: string; name?: string }> }>(
      ctx,
      "GET",
      "/users/me/organizations",
    );
    const orgs =
      orgsResponse.status >= 200 && orgsResponse.status < 300
        ? (orgsResponse.body?.organizations ?? [])
            .filter((o): o is { id: string; name?: string } => typeof o?.id === "string" && o.id.length > 0)
            .map((o) => ({ id: o.id, name: o.name?.trim() || o.id }))
        : [];
    return { accountName: accountName.slice(0, 255), orgs };
  }

  // ------------------------------------------------------------- projects --

  /** The project, or null when it no longer exists on Neon. */
  async findProject(
    ctx: NeonContext,
    neonProjectId: string,
  ): Promise<{ neonProjectId: string; name: string; regionId: string; pgVersion: number } | null> {
    const response = await neonRequest<{
      project?: { id?: string; name?: string; region_id?: string; pg_version?: number };
    }>(ctx, "GET", `/projects/${encodeURIComponent(neonProjectId)}`);
    if (response.status === 404) return null;
    const project = expectOk(response, "reading the Neon project", [ctx.apiKey]).project ?? {};
    return {
      neonProjectId: project.id ?? neonProjectId,
      name: project.name ?? "",
      regionId: project.region_id ?? "",
      pgVersion: project.pg_version ?? 0,
    };
  }

  /**
   * Creates the project with its default branch, database and owner role, and
   * returns their names. A name conflict gets a random suffix, once.
   */
  async createProject(ctx: NeonContext, spec: ProjectSpec): Promise<ProjectInfo> {
    let name = spec.name;
    for (let attempt = 1; ; attempt++) {
      const response = await neonRequest<CreateResponse>(ctx, "POST", "/projects", {
        body: {
          project: {
            name,
            region_id: spec.regionId,
            pg_version: spec.pgVersion,
            ...(spec.orgId ? { org_id: spec.orgId } : {}),
          },
        },
      });
      if (response.status === 409 && attempt === 1) {
        const error = neonError(response, "creating the Neon project");
        if (error.code !== "neon_project_limit") {
          name = neonProjectName(spec.name, "", true);
          continue;
        }
      }
      return this.toProjectInfo(expectOk(response, "creating the Neon project", [ctx.apiKey]), spec, name);
    }
  }

  private toProjectInfo(body: CreateResponse, spec: ProjectSpec, name: string): ProjectInfo {
    const params = body.connection_uris?.[0]?.connection_parameters ?? {};
    const database = body.databases?.[0];
    const neonProjectId = body.project?.id;
    const branchId = body.branch?.id ?? database?.branch_id;
    const databaseName = database?.name ?? params.database;
    const roleName = database?.owner_name ?? params.role ?? body.roles?.find((r) => r.name && !r.protected)?.name;

    const missing = [
      !neonProjectId && "project id",
      !branchId && "branch",
      !databaseName && "database",
      !roleName && "role",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new ProviderError(
        `Neon created the project but its answer had no ${missing.join(", ")}. Check it on the Neon console.`,
        502,
        "neon_unexpected_response",
      );
    }
    return {
      neonProjectId: neonProjectId!,
      name: body.project?.name ?? name,
      regionId: body.project?.region_id ?? spec.regionId,
      pgVersion: body.project?.pg_version ?? spec.pgVersion,
      orgId: body.project?.org_id ?? spec.orgId,
      branchId: branchId!,
      databaseName: databaseName!,
      roleName: roleName!,
      host: body.endpoints?.[0]?.host ?? params.host ?? null,
    };
  }

  /**
   * Waits until none of the project's operations is still scheduled or
   * running: the compute is up and the database can be connected to.
   *
   * - A failed operation → `neon_provision_failed`.
   * - Still busy after `timeoutMs` → `neon_provision_timeout`. Nothing is
   *   lost: the next call waits again.
   * - `since` limits the check to operations started from then on, so an old
   *   failure on a long-lived project is not reported as new.
   */
  async waitForOperations(
    ctx: NeonContext,
    neonProjectId: string,
    options: { timeoutMs: number; since?: number },
  ): Promise<void> {
    const deadline = this.now() + options.timeoutMs;
    for (;;) {
      const response = await neonRequest<{ operations?: unknown }>(
        ctx,
        "GET",
        `/projects/${encodeURIComponent(neonProjectId)}/operations`,
        { query: { limit: 50 } },
      );
      if (response.status !== 423) {
        const all = asOperations(expectOk(response, "checking the Neon project", [ctx.apiKey]).operations);
        const operations =
          options.since === undefined
            ? all
            : all.filter((op) => {
                const created = Date.parse(String((op as { created_at?: string }).created_at ?? ""));
                return !Number.isFinite(created) || created >= options.since! - 60_000;
              });
        const failed = firstFailure(operations);
        if (failed) {
          throw new ProviderError(
            `Neon could not set up the database: ${describeFailure(failed)}.`,
            502,
            "neon_provision_failed",
          );
        }
        if (allFinished(operations)) return;
      }
      if (this.now() >= deadline) {
        throw new ProviderError(
          `Neon is still setting up the database after ${Math.round(options.timeoutMs / 1000)} s. ` +
            "Deploy again in a minute; it carries on from where it is.",
          504,
          "neon_provision_timeout",
          { retryable: true },
        );
      }
      await this.sleep(this.pollIntervalMs, ctx.signal);
    }
  }

  // ----------------------------------------------------------- connection --

  /**
   * The pooled and direct connection strings, fetched fresh every time and
   * never stored. A 423 (an operation still running) is waited out briefly.
   */
  async getConnection(ctx: NeonContext, ref: DatabaseRef): Promise<{ pooledUri: string; directUri: string }> {
    const fetchUri = async (pooled: boolean): Promise<string> => {
      for (let attempt = 1; ; attempt++) {
        const response = await neonRequest<{ uri?: unknown }>(
          ctx,
          "GET",
          `/projects/${encodeURIComponent(ref.neonProjectId)}/connection_uri`,
          {
            query: {
              branch_id: ref.branchId,
              database_name: ref.databaseName,
              role_name: ref.roleName,
              pooled,
            },
          },
        );
        if (response.status === 423 && attempt < 5) {
          await this.sleep(this.pollIntervalMs * attempt, ctx.signal);
          continue;
        }
        if (response.status === 404) {
          throw new ProviderError(
            "The Neon project (or its database or role) no longer exists. Provision the database again.",
            404,
            "neon_database_gone",
            { providerStatus: 404 },
          );
        }
        const uri = expectOk(response, "reading the connection string", [ctx.apiKey]).uri;
        if (!isPostgresUri(uri)) {
          throw new ProviderError("Neon returned no usable connection string.", 502, "neon_unexpected_response");
        }
        return uri;
      }
    };
    const pooledUri = await fetchUri(true);
    const directUri = await fetchUri(false);
    return { pooledUri, directUri };
  }

  /** Deletes the project and everything in it. Implemented; not called by the MVP. */
  async deleteProject(ctx: NeonContext, neonProjectId: string): Promise<void> {
    const response = await neonRequest(ctx, "DELETE", `/projects/${encodeURIComponent(neonProjectId)}`);
    if (response.status === 404) return;
    expectOk(response, "deleting the Neon project", [ctx.apiKey]);
  }
}
