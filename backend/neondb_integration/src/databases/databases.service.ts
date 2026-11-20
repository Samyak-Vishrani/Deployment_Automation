import { notFound, ProviderError, ServiceError } from "@orbitops/integration-common/provider-error";
import type { NeonDatabase } from "@prisma/client";
import type { CredentialsService, KeyScope } from "../credentials/credentials.service";
import type { Db } from "../db";
import { consoleUrl } from "../neon/connection";
import type { NeonContext } from "../neon/neon-http";
import type { NeonProvider } from "../neon/neon.provider";
import { neonProjectName } from "../neon/project-name";
import type { ConnectionView, DatabaseRequest, DatabaseState, DatabaseView } from "../types";

export interface DatabasesOptions {
  /** How long ensure() waits for Neon's operations before answering neon_provision_timeout. */
  provisionTimeoutMs: number;
  now?: () => number;
}

type Neon = Pick<NeonProvider, "findProject" | "createProject" | "waitForOperations" | "getConnection" | "deleteProject">;

/**
 * One Neon project per database component of the main backend.
 *
 * Provisioning is synchronous: `ensure` creates the project (or finds it),
 * waits until Neon has finished setting it up, and answers. It is idempotent
 * and serialised per component, so the backend can call it before every
 * backend deploy. Connection strings are never stored: `connection` fetches
 * them from Neon each time.
 */
export class DatabasesService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly neon: Neon,
    private readonly credentials: Pick<CredentialsService, "getKey" | "markInvalid">,
    private readonly options: DatabasesOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Creates the component's Neon project if needed and waits until it is ready. */
  ensure(request: DatabaseRequest): Promise<DatabaseView> {
    return this.withLock(request.componentId, () => this.ensureLocked(request));
  }

  async get(userId: string, componentId: string): Promise<DatabaseView> {
    return this.view(await this.owned(userId, componentId));
  }

  /** The pooled and direct connection strings, fresh from Neon. The only call that returns a secret. */
  async connection(userId: string, componentId: string): Promise<ConnectionView> {
    const row = await this.owned(userId, componentId);
    if (row.state !== "ready") {
      throw new ServiceError(
        `The Neon database for this component is ${row.state}, not ready. Provision it again.`,
        409,
        "neon_database_not_ready",
      );
    }
    const scope = await this.credentials.getKey(userId);
    try {
      return await this.neon.getConnection({ apiKey: scope.apiKey }, row);
    } catch (error) {
      await this.onError(userId, error);
      throw error;
    }
  }

  /** Deletes the Neon project and forgets it. Implemented; not called by the MVP. */
  async destroy(userId: string, componentId: string): Promise<{ deleted: boolean }> {
    return this.withLock(componentId, async () => {
      const row = await this.owned(userId, componentId);
      const scope = await this.credentials.getKey(userId);
      try {
        await this.neon.deleteProject({ apiKey: scope.apiKey }, row.neonProjectId);
      } catch (error) {
        await this.onError(userId, error);
        throw error;
      }
      await this.db.neonDatabase.delete({ where: { componentId } });
      return { deleted: true };
    });
  }

  // ------------------------------------------------------------ internals --

  private async ensureLocked(request: DatabaseRequest): Promise<DatabaseView> {
    const { userId, componentId } = request;
    const scope = await this.credentials.getKey(userId);
    const ctx: NeonContext = { apiKey: scope.apiKey };
    let row = await this.db.neonDatabase.findUnique({ where: { componentId } });
    if (row && row.userId !== userId) throw notFound(`No Neon database for component ${componentId}.`);

    const started = this.now();
    let created = false;
    let warning: string | null = null;
    try {
      if (row) {
        const project = await this.neon.findProject(ctx, row.neonProjectId);
        if (!project) {
          warning =
            `The Neon project ${row.name} (${row.neonProjectId}) was deleted on Neon, so a new, empty one was ` +
            "created. Its data is not recovered.";
          row = await this.create(ctx, request, scope);
          created = true;
        } else if (row.state === "ready") {
          return this.view(row, { created: false, warning: null });
        } else if (row.state === "failed") {
          // Setup never finished, so the project holds no data: replace it.
          await this.neon.deleteProject(ctx, row.neonProjectId).catch(() => undefined);
          warning = "The previous attempt failed while Neon set up the project; it was removed and created again.";
          row = await this.create(ctx, request, scope);
          created = true;
        }
      } else {
        row = await this.create(ctx, request, scope);
        created = true;
      }

      await this.neon.waitForOperations(ctx, row.neonProjectId, {
        timeoutMs: this.options.provisionTimeoutMs,
        since: created ? started : undefined,
      });
      row = await this.db.neonDatabase.update({ where: { componentId }, data: { state: "ready", lastError: null } });
      return this.view(row, { created, warning });
    } catch (error) {
      await this.onError(userId, error);
      if (row && error instanceof ProviderError && error.code === "neon_provision_failed") {
        await this.db.neonDatabase.update({ where: { componentId }, data: { state: "failed", lastError: error.message } });
      }
      throw error;
    }
  }

  /**
   * Creates the Neon project and records it straight away, as `provisioning`,
   * before waiting: if this call is interrupted, the next one finds the
   * project instead of creating a second.
   */
  private async create(ctx: NeonContext, request: DatabaseRequest, scope: KeyScope): Promise<NeonDatabase> {
    const info = await this.neon.createProject(ctx, {
      name: neonProjectName(request.projectName, request.componentName),
      regionId: scope.regionId,
      pgVersion: scope.pgVersion,
      orgId: scope.orgId,
    });
    const data = {
      userId: request.userId,
      neonProjectId: info.neonProjectId,
      name: info.name.slice(0, 64),
      orgId: info.orgId,
      regionId: info.regionId,
      pgVersion: info.pgVersion,
      branchId: info.branchId,
      databaseName: info.databaseName,
      roleName: info.roleName,
      host: info.host,
      state: "provisioning" satisfies DatabaseState,
      lastError: null,
    };
    return this.db.neonDatabase.upsert({
      where: { componentId: request.componentId },
      create: { componentId: request.componentId, ...data },
      update: data,
    });
  }

  private async owned(userId: string, componentId: string): Promise<NeonDatabase> {
    const row = await this.db.neonDatabase.findUnique({ where: { componentId } });
    if (!row || row.userId !== userId) throw notFound(`No Neon database for component ${componentId}.`);
    return row;
  }

  private async onError(userId: string, error: unknown): Promise<void> {
    if (error instanceof ProviderError && error.invalidToken) {
      await this.credentials.markInvalid(userId);
    }
  }

  private withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.locks.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      });
    return next;
  }

  private view(row: NeonDatabase, extras: { created?: boolean; warning?: string | null } = {}): DatabaseView {
    return {
      componentId: row.componentId,
      state: row.state as DatabaseState,
      neonProjectId: row.neonProjectId,
      name: row.name,
      regionId: row.regionId,
      pgVersion: row.pgVersion,
      host: row.host,
      databaseName: row.databaseName,
      roleName: row.roleName,
      consoleUrl: consoleUrl(row.neonProjectId),
      ...("created" in extras ? { created: extras.created } : {}),
      ...("warning" in extras ? { warning: extras.warning ?? null } : {}),
      lastError: row.lastError,
    };
  }
}
