import { abortableSleep } from "../http/provider-fetch";
import { ProviderError } from "../http/provider-error";
import type { ComponentSpec, EnvVar, LogLine, NormalisedStatus, RepoSpec } from "../types";
import { envHash, keysToDelete, toEnvVars } from "./env-vars";
import { safeServiceUrl } from "./error-hints";
import { toLogLines, type RenderLogPage } from "./log-map";
import { expectOk, renderRequest, type RenderContext } from "./render-http";
import { randomSuffix, renderServiceName } from "./service-name";
import {
  createServiceBody,
  patchServiceBody,
  settingsHash,
  toServiceSettings,
  type ServiceDefaults,
} from "./service-settings";
import { normaliseDeployStatus } from "./status-map";

/*
 * How deploys reach Render
 * ------------------------
 * Render builds from GitHub itself: there is no file-upload deploy, so the
 * user's Render account must be connected to GitHub with access to the repo
 * (public repos may work without it - `npm run spike` shows).
 *
 * 1. The web service is created with autoDeployTrigger "off": a push never
 *    deploys on Render's own, OrbitOps triggers every deploy.
 * 2. Creating a service starts a deploy of the branch head straight away. If
 *    that deploy is building exactly our commit it is adopted; otherwise it is
 *    cancelled and our commit is deployed, so the row always matches the SHA.
 * 3. Later deploys PATCH only changed settings, sync only changed env vars,
 *    then POST a deploy with `commitId`.
 */

export interface Owner {
  id: string;
  name: string;
  type: string;
}

export interface AccountInfo {
  accountName: string;
  owners: Owner[];
}

/** A Render service as this service remembers it (the RenderService row). */
export interface KnownService {
  renderServiceId: string;
  name: string;
  ownerId: string;
  region: string;
  plan: string;
  runtime: string;
  url: string | null;
  dashboardUrl: string | null;
  settingsHash: string;
  envHash: string;
  managedEnvKeys: string[];
}

export interface EnsuredService extends KnownService {
  created: boolean;
  /** The deploy Render started by itself when the service was created. */
  initialDeployId: string | null;
}

export interface DeployResult {
  providerDeploymentId: string;
  status: NormalisedStatus;
  dashboardUrl: string;
  adopted: boolean;
}

export interface StatusResult {
  status: NormalisedStatus;
  /** Render's own status word, for failure messages. */
  rawStatus: string;
}

interface RenderServiceBody {
  id?: string;
  name?: string;
  dashboardUrl?: string;
  serviceDetails?: { url?: string };
}

interface RenderDeployBody {
  id?: string;
  status?: string;
  commit?: { id?: string };
}

const dashboardFor = (serviceId: string, deployId?: string) =>
  `https://dashboard.render.com/web/${serviceId}${deployId ? `/deploys/${deployId}` : ""}`;

const MAX_LOG_PAGES = 5;

export class RenderProvider {
  readonly id = "render" as const;

  constructor(private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep) {}

  // ------------------------------------------------------------ account ----

  /** Lists the workspaces ("owners") the key can use; also proves the key works. */
  async validateCredentials(apiKey: string, signal?: AbortSignal): Promise<AccountInfo> {
    const ctx: RenderContext = { apiKey, signal };
    const owners: Owner[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await renderRequest<Array<{ owner?: { id?: string; name?: string; email?: string; type?: string }; cursor?: string }>>(
        ctx,
        "GET",
        "/owners",
        { query: { limit: 100, cursor } },
      );
      const rows = expectOk(response, "checking the API key", [apiKey]) ?? [];
      for (const row of rows) {
        if (row.owner?.id) {
          owners.push({
            id: row.owner.id,
            name: row.owner.name ?? row.owner.email ?? row.owner.id,
            type: row.owner.type ?? "user",
          });
        }
      }
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1]?.cursor;
      if (!cursor) break;
    }
    if (owners.length === 0) {
      throw new ProviderError("This Render API key cannot see any workspace.", 400, "render_error");
    }
    const personal = owners.find((o) => o.type === "user") ?? owners[0];
    return { accountName: personal.name, owners };
  }

  // ------------------------------------------------------------ service ----

  /**
   * Makes sure a web service exists for the component, with current settings
   * and env vars. Looks up before it creates: `known` is what we stored.
   */
  async ensureService(
    ctx: RenderContext,
    known: KnownService | null,
    component: ComponentSpec,
    repo: RepoSpec,
    defaults: ServiceDefaults,
    env: EnvVar[],
    log: (line: string) => void,
  ): Promise<EnsuredService> {
    const settings = toServiceSettings(component, repo, defaults);
    const vars = toEnvVars(env, component, settings.runtime);
    const hash = settingsHash(settings);
    const eHash = envHash(vars);
    const secrets = [ctx.apiKey, ...vars.map((v) => v.value)];

    if (known) {
      const existing = await renderRequest<RenderServiceBody>(
        ctx,
        "GET",
        `/services/${encodeURIComponent(known.renderServiceId)}`,
      );
      if (existing.status === 404) {
        log(`Render service ${known.name} no longer exists (deleted on Render?); creating it again.`);
      } else {
        const service = expectOk(existing, "reading the Render service", secrets);
        if (
          known.runtime !== settings.runtime ||
          known.region !== defaults.region ||
          known.plan !== defaults.plan
        ) {
          log(
            `Note: runtime, region and plan are fixed once a Render service exists ` +
              `(this one: ${known.runtime}, ${known.region}, ${known.plan}). Change them on Render if needed.`,
          );
        }
        if (known.settingsHash !== hash) {
          log(`Build settings changed; updating Render service ${known.name}.`);
          const patched = await renderRequest(ctx, "PATCH", `/services/${encodeURIComponent(known.renderServiceId)}`, {
            body: patchServiceBody(settings),
          });
          expectOk(patched, "updating the Render service", secrets);
        }
        let managedEnvKeys = known.managedEnvKeys;
        if (known.envHash !== eHash) {
          managedEnvKeys = await this.syncEnv(ctx, known.renderServiceId, known.managedEnvKeys, vars, log);
        }
        return {
          ...known,
          url: safeServiceUrl(service?.serviceDetails?.url) ?? known.url,
          settingsHash: hash,
          envHash: eHash,
          managedEnvKeys,
          created: false,
          initialDeployId: null,
        };
      }
    }

    return this.createService(ctx, component, repo, defaults, settings, vars, hash, eHash, log);
  }

  private async createService(
    ctx: RenderContext,
    component: ComponentSpec,
    repo: RepoSpec,
    defaults: ServiceDefaults,
    settings: ReturnType<typeof toServiceSettings>,
    vars: EnvVar[],
    hash: string,
    eHash: string,
    log: (line: string) => void,
  ): Promise<EnsuredService> {
    const secrets = [ctx.apiKey, ...vars.map((v) => v.value)];
    let name = renderServiceName(repo.fullName, component.name);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await renderRequest<{ service?: RenderServiceBody; deployId?: string }>(ctx, "POST", "/services", {
        body: createServiceBody(name, defaults.ownerId, repo, settings, vars),
        // Creating is not idempotent: never retry it on a network error.
        fetch: { retryOnNetworkError: false, timeoutMs: 60_000 },
      });
      if (response.status === 409) {
        const next = renderServiceName(repo.fullName, component.name, randomSuffix());
        log(`A Render service named ${name} already exists; using ${next}.`);
        name = next;
        continue;
      }
      const body = expectOk(response, "creating the Render service", secrets);
      const service = body?.service;
      if (!service?.id) {
        throw new ProviderError("Render created the service but returned no id.", 502, "render_error");
      }
      log(
        `Created Render web service ${service.name ?? name} (${settings.runtime}, ${defaults.region}, ` +
          `${defaults.plan} plan) from ${repo.fullName}@${repo.branch}` +
          (settings.rootDir ? `, root ${settings.rootDir}` : "") +
          `, with ${vars.length} env var${vars.length === 1 ? "" : "s"}.`,
      );
      return {
        renderServiceId: service.id,
        name: service.name ?? name,
        ownerId: defaults.ownerId,
        region: defaults.region,
        plan: defaults.plan,
        runtime: settings.runtime,
        url: safeServiceUrl(service.serviceDetails?.url),
        dashboardUrl: service.dashboardUrl ?? dashboardFor(service.id),
        settingsHash: hash,
        envHash: eHash,
        managedEnvKeys: vars.map((v) => v.key),
        created: true,
        initialDeployId: body.deployId ?? null,
      };
    }

    throw new ProviderError(
      "Could not find a free Render service name after several attempts. Rename the component and try again.",
      409,
      "render_name_conflict",
    );
  }

  /**
   * Upserts each var and deletes managed keys that are gone. One key at a time:
   * Render's env endpoints are rate-limited and these sets are small.
   */
  private async syncEnv(
    ctx: RenderContext,
    serviceId: string,
    previous: string[],
    vars: EnvVar[],
    log: (line: string) => void,
  ): Promise<string[]> {
    const secrets = [ctx.apiKey, ...vars.map((v) => v.value)];
    for (const { key, value } of vars) {
      const response = await renderRequest(
        ctx,
        "PUT",
        `/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(key)}`,
        { body: { value } },
      );
      expectOk(response, `setting env var ${key}`, secrets);
    }
    const removed = keysToDelete(previous, vars);
    for (const key of removed) {
      const response = await renderRequest(
        ctx,
        "DELETE",
        `/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(key)}`,
      );
      if (response.status !== 404) expectOk(response, `removing env var ${key}`, secrets);
    }
    log(
      `Env vars updated on Render: ${vars.length} set` +
        (removed.length ? `, ${removed.length} removed (${removed.join(", ")})` : "") +
        ". Values are not logged.",
    );
    return vars.map((v) => v.key);
  }

  // ------------------------------------------------------------- deploy ----

  /**
   * Deploys exactly `commitSha`. A deploy Render started on its own (at
   * creation) is adopted when it builds that commit, otherwise cancelled.
   */
  async deploy(
    ctx: RenderContext,
    serviceId: string,
    commitSha: string,
    initialDeployId: string | null,
    log: (line: string) => void,
  ): Promise<DeployResult> {
    if (initialDeployId) {
      const initial = await renderRequest<RenderDeployBody>(
        ctx,
        "GET",
        `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(initialDeployId)}`,
      );
      if (initial.status === 200 && initial.body?.commit?.id === commitSha) {
        log(`Render started building ${commitSha.slice(0, 7)} when the service was created; following that deploy.`);
        return {
          providerDeploymentId: initialDeployId,
          status: "queued",
          dashboardUrl: dashboardFor(serviceId, initialDeployId),
          adopted: true,
        };
      }
      log("Render started a deploy of a different commit on creation; cancelling it to deploy the exact commit.");
      await this.cancel(ctx, serviceId, initialDeployId).catch(() => undefined);
    }

    const response = await renderRequest<RenderDeployBody>(
      ctx,
      "POST",
      `/services/${encodeURIComponent(serviceId)}/deploys`,
      { body: { commitId: commitSha, clearCache: "do_not_clear" }, fetch: { retryOnNetworkError: false } },
    );
    const deploy = expectOk(response, "starting the deploy", [ctx.apiKey]);
    if (!deploy?.id) {
      throw new ProviderError("Render accepted the deploy but returned no id.", 502, "render_error");
    }
    log(`Deploying ${commitSha.slice(0, 7)} on Render.`);
    return {
      providerDeploymentId: deploy.id,
      status: "queued",
      dashboardUrl: dashboardFor(serviceId, deploy.id),
      adopted: false,
    };
  }

  // ------------------------------------------------------------ observe ----

  async getStatus(ctx: RenderContext, serviceId: string, deployId: string): Promise<StatusResult> {
    const response = await renderRequest<RenderDeployBody>(
      ctx,
      "GET",
      `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
    );
    const deploy = expectOk(response, "reading the deploy status", [ctx.apiKey]);
    const rawStatus = deploy?.status ?? "";
    return { status: normaliseDeployStatus(rawStatus), rawStatus };
  }

  /** The service's public URL (assigned once the service exists). */
  async getServiceUrl(ctx: RenderContext, serviceId: string): Promise<string | null> {
    const response = await renderRequest<RenderServiceBody>(ctx, "GET", `/services/${encodeURIComponent(serviceId)}`);
    if (response.status !== 200) return null;
    return safeServiceUrl(response.body?.serviceDetails?.url);
  }

  /**
   * Build and app log lines since `since` (ISO timestamp), oldest first, and
   * the cursor to continue from. Follows Render's pagination a few pages per poll.
   */
  async getLogs(
    ctx: RenderContext,
    ownerId: string,
    serviceId: string,
    since: string | null,
  ): Promise<{ lines: LogLine[]; cursor: string | null }> {
    const lines: LogLine[] = [];
    let startTime = since ?? undefined;
    let cursor = since;
    for (let page = 0; page < MAX_LOG_PAGES; page++) {
      const response = await renderRequest<RenderLogPage>(ctx, "GET", "/logs", {
        query: {
          ownerId,
          resource: [serviceId],
          type: ["build", "app"],
          direction: "forward",
          limit: 100,
          startTime,
        },
      });
      const body = expectOk(response, "reading the build log", [ctx.apiKey]);
      const pageLines = toLogLines(body);
      lines.push(...pageLines);
      const newest = pageLines.reduce((max, l) => Math.max(max, l.at), 0);
      if (newest > 0) cursor = new Date(newest).toISOString();
      if (!body?.hasMore || !body.nextStartTime) break;
      startTime = body.nextStartTime;
    }
    return { lines, cursor };
  }

  // ------------------------------------------------------------- manage ----

  async cancel(ctx: RenderContext, serviceId: string, deployId: string): Promise<void> {
    const response = await renderRequest(
      ctx,
      "POST",
      `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}/cancel`,
    );
    // It already finished (or was never there), which is what we wanted.
    if ([400, 404, 409].includes(response.status)) return;
    expectOk(response, "cancelling the deploy", [ctx.apiKey]);
  }

  /** Puts a previous deploy back live (Phase 11's rollback). */
  async rollback(ctx: RenderContext, serviceId: string, deployId: string): Promise<string> {
    const response = await renderRequest<RenderDeployBody>(ctx, "POST", `/services/${encodeURIComponent(serviceId)}/rollback`, {
      body: { deployId },
    });
    const deploy = expectOk(response, "rolling back", [ctx.apiKey]);
    if (!deploy?.id) throw new ProviderError("Render accepted the rollback but returned no deploy id.", 502, "render_error");
    return deploy.id;
  }

  /** Upserts env vars (Phase 9). Never deletes. */
  async setEnv(ctx: RenderContext, serviceId: string, vars: EnvVar[]): Promise<void> {
    await this.syncEnv(ctx, serviceId, [], vars, () => undefined);
  }

  async destroy(ctx: RenderContext, serviceId: string): Promise<void> {
    const response = await renderRequest(ctx, "DELETE", `/services/${encodeURIComponent(serviceId)}`);
    if (response.status === 404) return;
    expectOk(response, "deleting the Render service", [ctx.apiKey]);
  }

  /**
   * After a deploy is live: GET the service a few times over ~90 s, because a
   * free instance may be waking up. Reports, never fails the deploy - Render's
   * own "live" is the source of truth.
   */
  async probeHealth(
    url: string,
    path: string | null,
    log: (line: string) => void,
    options: { attempts?: number; intervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const target = new URL(path || "/", url).toString();
    const attempts = options.attempts ?? 6;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
        await response.arrayBuffer().catch(() => undefined);
        if (response.status < 400) {
          log(`Health check: GET ${target} → HTTP ${response.status}.`);
          return true;
        }
        if (attempt === attempts) log(`Health check: GET ${target} → HTTP ${response.status}.`);
      } catch (error) {
        if (attempt === attempts) log(`Health check: GET ${target} did not answer (${(error as Error).message}).`);
      }
      if (attempt < attempts) await this.sleep(options.intervalMs ?? 15_000, options.signal);
    }
    log("The service is live on Render but did not answer the health check yet (a free instance can take ~1 min to wake).");
    return false;
  }
}
