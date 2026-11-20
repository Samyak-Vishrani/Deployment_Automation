import { Prisma, type Component, type EnvVar, type PrismaClient, type Project } from "@prisma/client";
import { badRequest, conflict, HttpError, notFound } from "@/lib/api/http-error";
import { envExampleKeys, type ComponentEnvKeys } from "@/lib/components/preflight";
import { open, seal } from "@/lib/crypto/secret-box";
import type { EventsService } from "@/lib/events/events.service";
import { envProblem, looksSecret, type EnvScope } from "./env-rules";
import type { EnvPutEntry, EnvPutInput } from "./env-input";
import { systemEnvKeys, type SystemEnvKey } from "./system-env";

/** A stored variable as the API shows it: never its value. */
export type EnvVarView = { key: string; isSecret: boolean; updatedAt: string };

export type ComponentEnvView = {
  componentId: string;
  name: string;
  kind: Component["kind"];
  provider: Component["provider"];
  vars: EnvVarView[];
  /** Set by OrbitOps at deploy time; keys only. */
  system: SystemEnvKey[];
  /** Backends also get the shared set. */
  receivesShared: boolean;
  revision: number;
  /** Saved env changes the running deployment does not have yet. */
  pendingRedeploy: boolean;
};

export type EnvironmentView = {
  projectId: string;
  /** Sent to every backend and to local Docker deploys. */
  shared: EnvVarView[];
  components: ComponentEnvView[];
};

export type EnvSuggestion = {
  key: string;
  /** The example's value, only for keys that do not look secret. */
  example: string | null;
  looksSecret: boolean;
  alreadySet: boolean;
  providedBySystem: boolean;
};

/** What a deploy is sent with. Values exist only in memory, on their way to a provider. */
export type ResolvedEnv = {
  vars: Array<{ key: string; value: string; secret: boolean }>;
  /** The secret values, for log redaction. */
  secrets: string[];
  revision: number;
};

/** Reads a file at the project's branch head; null when it does not exist. */
export type RepoFileReader = (project: Project, path: string) => Promise<string | null>;

const noRepo: RepoFileReader = async () => null;

const SCOPE_ORDER = { frontend: 0, backend: 1, database: 2 } as const;

/**
 * Environment variables, per component and shared (Phase 9).
 *
 * Every value is sealed with lib/crypto/secret-box. Nothing here returns a
 * value except `reveal` (non-secret rows only) and `resolve` (for a deploy,
 * in memory). Logs name keys only.
 */
export class EnvVarsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly events: Pick<EventsService, "projectChanged">,
    private readonly readRepoFile: RepoFileReader = noRepo,
  ) {}

  // ------------------------------------------------------------------ read --

  async list(userId: string, projectId: string): Promise<EnvironmentView> {
    await this.projectOrThrow(userId, projectId);
    const [rows, components] = await Promise.all([
      this.prisma.envVar.findMany({ where: { projectId }, orderBy: { key: "asc" } }),
      this.prisma.component.findMany({ where: { projectId }, orderBy: [{ kind: "asc" }, { rootDir: "asc" }] }),
    ]);

    const deployed = components.filter((c) => c.providerResourceId && c.kind !== "database").map((c) => c.id);
    const lastSuccess = deployed.length
      ? await this.prisma.deployment.findMany({
          where: { componentId: { in: deployed }, status: "success" },
          orderBy: { queuedAt: "desc" },
          distinct: ["componentId"],
          select: { componentId: true, envRevision: true },
        })
      : [];
    const appliedRevision = new Map(lastSuccess.map((d) => [d.componentId, d.envRevision ?? 0]));

    const view = (r: EnvVar): EnvVarView => ({ key: r.key, isSecret: r.isSecret, updatedAt: r.updatedAt.toISOString() });
    return {
      projectId,
      shared: rows.filter((r) => r.componentId === null).map(view),
      components: [...components]
        .sort((a, b) => SCOPE_ORDER[a.kind] - SCOPE_ORDER[b.kind])
        .map((c) => ({
          componentId: c.id,
          name: c.name,
          kind: c.kind,
          provider: c.provider,
          vars: rows.filter((r) => r.componentId === c.id).map(view),
          system: systemEnvKeys(c, components),
          receivesShared: c.kind === "backend",
          revision: c.envRevision,
          pendingRedeploy: appliedRevision.has(c.id) && c.envRevision > (appliedRevision.get(c.id) ?? 0),
        })),
    };
  }

  /** The value of a NON-secret variable. Secrets are write-only. */
  async reveal(userId: string, projectId: string, componentId: string | null, key: string): Promise<{ key: string; value: string }> {
    await this.projectOrThrow(userId, projectId);
    if (componentId) await this.componentOrThrow(projectId, componentId);
    const row = await this.prisma.envVar.findFirst({ where: { projectId, componentId, key } });
    if (!row) throw notFound(`No variable ${key} here.`);
    if (row.isSecret) {
      throw new HttpError(`${key} is a secret: its value can't be shown. Enter a new value to replace it.`, 403, "env_secret");
    }
    return { key, value: open(row.valueEnc) };
  }

  /** Keys from the component's `<rootDir>/.env.example`, at the branch head. */
  async suggestions(
    userId: string,
    projectId: string,
    componentId: string,
  ): Promise<{ path: string; found: boolean; suggestions: EnvSuggestion[] }> {
    const project = await this.projectOrThrow(userId, projectId);
    const component = await this.componentOrThrow(projectId, componentId);
    const path = component.rootDir === "." ? ".env.example" : `${component.rootDir}/.env.example`;
    const content = await this.readRepoFile(project, path);
    if (content === null) return { path, found: false, suggestions: [] };

    const [rows, siblings] = await Promise.all([
      this.prisma.envVar.findMany({
        where: component.kind === "backend" ? { projectId, OR: [{ componentId }, { componentId: null }] } : { projectId, componentId },
        select: { key: true },
      }),
      this.prisma.component.findMany({ where: { projectId } }),
    ]);
    const set = new Set(rows.map((r) => r.key));
    const system = new Set(systemEnvKeys(component, siblings).map((s) => s.key));
    const examples = exampleValues(content);

    return {
      path,
      found: true,
      suggestions: envExampleKeys(content).map((key) => {
        const secret = looksSecret(key);
        return {
          key,
          example: secret ? null : (examples.get(key) ?? null),
          looksSecret: secret,
          alreadySet: set.has(key),
          providedBySystem: system.has(key),
        };
      }),
    };
  }

  // ----------------------------------------------------------------- write --

  /**
   * Replaces one scope's set: `componentId` null = shared. Keys left out are
   * deleted; a value left out is kept. Bumps the env revision of every
   * component the change reaches, so the UI can say "redeploy to apply".
   */
  async put(userId: string, projectId: string, componentId: string | null, dto: EnvPutInput): Promise<EnvironmentView> {
    await this.projectOrThrow(userId, projectId);
    const component = componentId ? await this.componentOrThrow(projectId, componentId) : null;
    const scope: EnvScope = component ? { kind: component.kind, provider: component.provider, name: component.name } : { kind: "shared" };
    const label = component ? component.name : "shared";

    const existing = await this.prisma.envVar.findMany({ where: { projectId, componentId } });
    const byKey = new Map(existing.map((r) => [r.key, r]));

    for (const entry of dto.vars) {
      const current = byKey.get(entry.key);
      if (!current && entry.value === undefined) {
        throw new HttpError(`${entry.key} is new, so it needs a value.`, 400, "env_value_required");
      }
      if (current?.isSecret && !entry.isSecret && entry.value === undefined) {
        throw new HttpError(
          `${entry.key} was saved as a secret. Enter its value again to make it a readable (non-secret) variable.`,
          400,
          "env_value_required",
        );
      }
    }

    // Kept values count towards size limits (Vercel's 64 KB total), so open them.
    const problem = envProblem(
      dto.vars.map((e) => ({ ...e, value: e.value ?? openOrEmpty(byKey.get(e.key)) })),
      scope,
    );
    if (problem) throw badRequest(problem);

    const wanted = new Set(dto.vars.map((e) => e.key));
    const removed = existing.filter((r) => !wanted.has(r.key));
    const added: EnvPutEntry[] = [];
    const changed: Array<{ row: EnvVar; entry: EnvPutEntry }> = [];
    for (const entry of dto.vars) {
      const current = byKey.get(entry.key);
      if (!current) {
        added.push(entry);
        continue;
      }
      const valueChanged = entry.value !== undefined && entry.value !== openOrEmpty(current);
      if (valueChanged || current.isSecret !== entry.isSecret) changed.push({ row: current, entry });
    }

    if (removed.length + added.length + changed.length > 0) {
      try {
        await this.prisma.$transaction(async (tx) => {
          if (removed.length) await tx.envVar.deleteMany({ where: { id: { in: removed.map((r) => r.id) } } });
          for (const { row, entry } of changed) {
            await tx.envVar.update({
              where: { id: row.id },
              data: { isSecret: entry.isSecret, ...(entry.value !== undefined && { valueEnc: seal(entry.value) }) },
            });
          }
          if (added.length) {
            await tx.envVar.createMany({
              data: added.map((e) => ({ projectId, componentId, key: e.key, valueEnc: seal(e.value ?? ""), isSecret: e.isSecret })),
            });
          }
          // Shared vars reach every backend.
          if (component) {
            await tx.component.update({ where: { id: component.id }, data: { envRevision: { increment: 1 } } });
          } else {
            await tx.component.updateMany({ where: { projectId, kind: "backend" }, data: { envRevision: { increment: 1 } } });
          }
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw conflict("These variables were changed at the same time somewhere else. Reload and try again.");
        }
        throw error;
      }
      console.log(
        `[env] ${userId} saved ${label} of ${projectId}: ` +
          [
            added.length && `+${added.map((e) => e.key).join(",")}`,
            changed.length && `~${changed.map((c) => c.entry.key).join(",")}`,
            removed.length && `-${removed.map((r) => r.key).join(",")}`,
          ]
            .filter(Boolean)
            .join(" "),
      );
      this.events.projectChanged(projectId, "updated");
    }

    return this.list(userId, projectId);
  }

  /**
   * PATCH /projects/:id with `envVars` (the pre-Phase-9 API): replaces the
   * shared set from a plain object. Keys that existed keep their secret flag;
   * new ones are secrets.
   */
  async replaceSharedFromRecord(userId: string, projectId: string, record: Record<string, string>): Promise<void> {
    const existing = await this.prisma.envVar.findMany({ where: { projectId, componentId: null } });
    const flags = new Map(existing.map((r) => [r.key, r.isSecret]));
    await this.put(userId, projectId, null, {
      vars: Object.entries(record).map(([key, value]) => ({ key, value, isSecret: flags.get(key) ?? true })),
    });
  }

  // ---------------------------------------------------------------- deploy --

  /**
   * The variables a deploy is sent with. `component` null = a local Docker
   * deploy of the whole project.
   *
   * - backend: shared, overlaid with its own (its own wins);
   * - frontend: its own only;
   * - local Docker (null): shared;
   * - database: nothing.
   */
  async resolve(projectId: string, component: Pick<Component, "id" | "kind"> | null): Promise<ResolvedEnv> {
    if (component?.kind === "database") return { vars: [], secrets: [], revision: 0 };
    // Read the revision first: a change landing in between leaves the badge on, never off.
    const revision = component
      ? ((await this.prisma.component.findUnique({ where: { id: component.id }, select: { envRevision: true } }))?.envRevision ?? 0)
      : 0;

    const shared = !component || component.kind === "backend";
    const rows = await this.prisma.envVar.findMany({
      where: component
        ? shared
          ? { projectId, OR: [{ componentId: null }, { componentId: component.id }] }
          : { projectId, componentId: component.id }
        : { projectId, componentId: null },
    });

    const merged = new Map<string, { value: string; secret: boolean }>();
    for (const row of rows.filter((r) => r.componentId === null)) merged.set(row.key, { value: open(row.valueEnc), secret: row.isSecret });
    for (const row of rows.filter((r) => r.componentId !== null)) merged.set(row.key, { value: open(row.valueEnc), secret: row.isSecret });

    const vars = [...merged]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, { value, secret }]) => ({ key, value, secret }));
    return { vars, secrets: vars.filter((v) => v.secret && v.value).map((v) => v.value), revision };
  }

  /**
   * For pre-flight: per component, the stored keys and those with a non-empty
   * value, by the same scope rules as `resolve` (a backend includes shared).
   */
  async keysFor(projectId: string): Promise<(component: { id: string; kind: Component["kind"] }) => ComponentEnvKeys> {
    const rows = await this.prisma.envVar.findMany({ where: { projectId } });
    const withValue = new Set(rows.filter((r) => openOrEmpty(r).trim() !== "").map((r) => r.id));
    return (component) => {
      if (component.kind === "database") return { keys: [], filled: new Set() };
      const mine = rows.filter((r) => r.componentId === component.id || (component.kind === "backend" && r.componentId === null));
      return { keys: [...new Set(mine.map((r) => r.key))], filled: new Set(mine.filter((r) => withValue.has(r.id)).map((r) => r.key)) };
    };
  }

  // ------------------------------------------------------------- migration --

  /**
   * Moves the pre-Phase-9 `Project.envVars` JSON into sealed shared rows, once
   * per project, at startup. Values become secrets (we cannot tell which
   * were). Revisions are not bumped: what the backends get is unchanged.
   */
  async migrateLegacy(): Promise<number> {
    const projects = await this.prisma.project.findMany({ select: { id: true, name: true, envVars: true } });
    let moved = 0;
    for (const project of projects) {
      const record = asRecord(project.envVars);
      const keys = Object.keys(record);
      if (keys.length === 0) continue;

      const already = await this.prisma.envVar.count({ where: { projectId: project.id, componentId: null } });
      if (already > 0) {
        console.warn(`[env] ${project.name} has both old env vars and shared rows; leaving the old ones (keys: ${keys.join(", ")}) unused.`);
        continue;
      }
      await this.prisma.$transaction([
        this.prisma.envVar.createMany({
          data: keys.map((key) => ({ projectId: project.id, componentId: null, key, valueEnc: seal(record[key]), isSecret: true })),
        }),
        this.prisma.project.update({ where: { id: project.id }, data: { envVars: {} } }),
      ]);
      moved++;
      console.log(`[env] Moved ${keys.length} env var(s) of ${project.name} into EnvVar (keys: ${keys.join(", ")}).`);
    }
    return moved;
  }

  // ------------------------------------------------------------- internals --

  private async projectOrThrow(userId: string, projectId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== userId) throw notFound(`Project ${projectId} not found.`);
    return project;
  }

  private async componentOrThrow(projectId: string, componentId: string): Promise<Component> {
    const component = await this.prisma.component.findUnique({ where: { id: componentId } });
    if (!component || component.projectId !== projectId) throw notFound(`Component ${componentId} not found.`);
    if (component.kind === "database") {
      throw badRequest(`${component.name} is a database: it has no env vars. Its connection string goes to the backend as DATABASE_URL.`);
    }
    return component;
  }
}

/**
 * Rows for a new project's shared set (the textarea on /deploy/new), sealed.
 * Throws a 400 naming the first bad key.
 */
export function sharedRowsFor(projectId: string, record: Record<string, string>): Prisma.EnvVarCreateManyInput[] {
  const entries = Object.entries(record).map(([key, value]) => ({ key, value, isSecret: true }));
  const problem = envProblem(entries, { kind: "shared" });
  if (problem) throw badRequest(problem);
  return entries.map((e) => ({ projectId, componentId: null, key: e.key, valueEnc: seal(e.value), isSecret: true }));
}

function openOrEmpty(row: EnvVar | undefined): string {
  return row ? open(row.valueEnc) : "";
}

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** `KEY=value` values in a .env.example, unquoted. */
function exampleValues(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const hash = value.search(/\s#/);
    if (hash >= 0 && !/^["']/.test(value)) value = value.slice(0, hash).trim();
    value = value.replace(/^(["'])(.*)\1$/, "$2");
    if (value) values.set(match[1], value.slice(0, 500));
  }
  return values;
}
