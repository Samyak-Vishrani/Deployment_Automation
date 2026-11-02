import type { ProviderResponse } from "../http/provider-fetch";
import { ProviderError } from "../http/provider-error";
import type { ComponentSpec, LogLine, NormalisedStatus, RepoSpec, SourceMode } from "../types";
import { toLogLines } from "./log-map";
import { randomSuffix, vercelProjectName } from "./project-name";
import { settingsHash, toProjectSettings, type VercelProjectSettings } from "./project-settings";
import { normaliseReadyState } from "./status-map";
import { errorOf, expectOk, vercelError, vercelRequest, type VercelContext } from "./vercel-http";
import { formatBytes, hashFiles, missingShas, uploadFiles } from "./vercel-upload";
import { listFiles } from "../github/source-archive";

/*
 * How deploys reach Vercel
 * ------------------------
 * 1. The project is created linked to the GitHub repo (`gitRepository`) when
 *    Vercel's GitHub app can see it. Vercel's own deploy-on-push is then
 *    switched off (`gitProviderOptions.createDeployments = "disabled"`), so a
 *    push never deploys twice: we own triggering.
 * 2. A linked project deploys from a Git source at the exact commit.
 * 3. Otherwise - Vercel's GitHub app not installed, or it rejects the Git
 *    source - the repo is downloaded from GitHub at that commit and uploaded.
 *
 * Vercel does not document its error codes for "no access to this repo", so
 * those are recognised by pattern (isGitAccessError). `npm run spike` prints
 * the real responses for a given account; tighten the pattern from them.
 */

export interface AccountInfo {
  accountId: string;
  accountName: string;
  defaultTeamId: string | null;
  teams: Array<{ id: string; slug: string; name: string }>;
}

/** A Vercel project as this service remembers it (the VercelProject row). */
export interface KnownProject {
  vercelProjectId: string;
  name: string;
  gitLinked: boolean;
  settingsHash: string;
}

export interface EnsuredProject extends KnownProject {
  created: boolean;
  updated: boolean;
}

export interface DeployResult {
  providerDeploymentId: string;
  url: string | null;
  inspectorUrl: string | null;
  sourceMode: SourceMode;
  readyState: NormalisedStatus;
}

export interface StatusResult {
  status: NormalisedStatus;
  url: string | null;
  productionUrl: string | null;
  inspectorUrl: string | null;
  errorMessage: string | null;
}

export interface DeployInput {
  project: KnownProject;
  repo: RepoSpec;
  commitSha: string;
  deploymentId: string;
  log: (line: string) => void;
  /**
   * Downloads the source at `commitSha` and returns the folder it is in. Absent
   * when no GitHub token is available (a deploy resumed after a restart).
   */
  prepareUpload?: () => Promise<string>;
}

export interface EnvVarInput {
  key: string;
  value: string;
  /** "encrypted" (default) or "sensitive" (write-only on Vercel too). */
  type?: "encrypted" | "sensitive" | "plain";
  target?: Array<"production" | "preview" | "development">;
}

interface VercelDeploymentBody {
  id?: string;
  url?: string;
  inspectorUrl?: string;
  readyState?: string;
  alias?: string[];
  errorMessage?: string;
  errorCode?: string;
}

/** A Vercel answer that means "your GitHub app cannot read this repository". */
export function isGitAccessError(response: ProviderResponse<unknown>): boolean {
  if (![400, 403, 404, 422].includes(response.status)) return false;
  const error = errorOf(response.body);
  if (error.invalidToken) return false;
  const text = `${error.code ?? ""} ${error.message ?? ""}`;
  return /git|github|repo|integration|install|login connection/i.test(text);
}

export class VercelProvider {
  readonly id = "vercel" as const;

  // ------------------------------------------------------------ account ----

  async validateCredentials(token: string, signal?: AbortSignal): Promise<AccountInfo> {
    const ctx: VercelContext = { token, teamId: null, signal };
    const userResponse = await vercelRequest<{
      user?: { id?: string; username?: string; name?: string; email?: string; defaultTeamId?: string | null };
    }>(ctx, "GET", "/v2/user");
    const body = expectOk(userResponse, "checking the token");
    const user = body?.user;
    if (!user?.id) {
      throw new ProviderError("Vercel did not return an account for this token.", 400, "vercel_error");
    }

    // A team-scoped token may not be allowed to list teams; that is not fatal.
    const teamsResponse = await vercelRequest<{ teams?: Array<{ id?: string; slug?: string; name?: string }> }>(
      ctx,
      "GET",
      "/v2/teams",
      { query: { limit: 100 } },
    );
    const teams =
      teamsResponse.status === 200
        ? (teamsResponse.body?.teams ?? [])
            .filter((t) => t.id && t.slug)
            .map((t) => ({ id: t.id!, slug: t.slug!, name: t.name ?? t.slug! }))
        : [];

    return {
      accountId: user.id,
      accountName: user.username ?? user.name ?? user.email ?? user.id,
      defaultTeamId: user.defaultTeamId ?? null,
      teams,
    };
  }

  // ------------------------------------------------------------ project ----

  /**
   * Makes sure a Vercel project exists for the component with the current
   * settings. Looks up before it creates: `known` is what we stored last time.
   */
  async ensureProject(
    ctx: VercelContext,
    known: KnownProject | null,
    component: ComponentSpec,
    repo: RepoSpec,
    log: (line: string) => void,
  ): Promise<EnsuredProject> {
    const settings = toProjectSettings(component);
    const hash = settingsHash(settings);

    if (known) {
      const existing = await vercelRequest(ctx, "GET", `/v9/projects/${encodeURIComponent(known.vercelProjectId)}`);
      if (existing.status === 404) {
        log(`Vercel project ${known.name} no longer exists (deleted on Vercel?); creating it again.`);
      } else {
        expectOk(existing, "reading the Vercel project");
        if (known.settingsHash === hash) {
          return { ...known, created: false, updated: false };
        }
        log(`Build settings changed; updating Vercel project ${known.name}.`);
        await this.patchSettings(ctx, known.vercelProjectId, settings);
        return { ...known, settingsHash: hash, created: false, updated: true };
      }
    }

    return this.createProject(ctx, component, repo, settings, hash, log);
  }

  private async createProject(
    ctx: VercelContext,
    component: ComponentSpec,
    repo: RepoSpec,
    settings: VercelProjectSettings,
    hash: string,
    log: (line: string) => void,
  ): Promise<EnsuredProject> {
    const { nodeVersion, ...createSettings } = settings;
    let name = vercelProjectName(repo.fullName, component.name);
    let linkGit = true;

    for (let attempt = 1; attempt <= 4; attempt++) {
      const response = await vercelRequest<{ id?: string; name?: string }>(ctx, "POST", "/v11/projects", {
        body: {
          name,
          ...createSettings,
          ...(linkGit ? { gitRepository: { type: "github", repo: repo.fullName } } : {}),
        },
      });

      if (response.status === 409) {
        const next = vercelProjectName(repo.fullName, component.name, randomSuffix());
        log(`A Vercel project named ${name} already exists; using ${next}.`);
        name = next;
        continue;
      }
      if (linkGit && isGitAccessError(response)) {
        log(
          "Vercel's GitHub app cannot see this repository, so the project is not linked to it. " +
            "Deploys will upload files instead (install Vercel's GitHub app on the repo to avoid that).",
        );
        linkGit = false;
        continue;
      }

      const created = expectOk(response, "creating the Vercel project");
      if (!created?.id) {
        throw new ProviderError("Vercel created the project but returned no id.", 502, "vercel_error");
      }
      log(`Created Vercel project ${created.name ?? name}${linkGit ? `, linked to ${repo.fullName}` : ""}.`);

      if (nodeVersion) {
        await this.patchSettings(ctx, created.id, { ...settings });
      }
      if (linkGit) {
        await this.disableGitDeployments(ctx, created.id, log);
      }

      return {
        vercelProjectId: created.id,
        name: created.name ?? name,
        gitLinked: linkGit,
        settingsHash: hash,
        created: true,
        updated: false,
      };
    }

    throw new ProviderError(
      "Could not find a free Vercel project name after several attempts. Rename the component and try again.",
      409,
      "vercel_name_conflict",
    );
  }

  private async patchSettings(ctx: VercelContext, projectId: string, settings: VercelProjectSettings): Promise<void> {
    const { nodeVersion, ...rest } = settings;
    const response = await vercelRequest(ctx, "PATCH", `/v9/projects/${encodeURIComponent(projectId)}`, {
      // nodeVersion cannot be "unset"; leaving it out keeps Vercel's default.
      body: { ...rest, ...(nodeVersion ? { nodeVersion } : {}) },
    });
    expectOk(response, "updating the Vercel project's build settings");
  }

  /**
   * Stops Vercel from deploying on every push to the linked repo. If Vercel
   * refuses (the option is account- or plan-dependent), the deploy continues
   * with a warning: the cost is a duplicate deploy per push, not a failure.
   */
  private async disableGitDeployments(ctx: VercelContext, projectId: string, log: (line: string) => void) {
    const response = await vercelRequest(ctx, "PATCH", `/v9/projects/${encodeURIComponent(projectId)}`, {
      body: { gitProviderOptions: { createDeployments: "disabled" } },
    });
    if (response.status < 200 || response.status >= 300) {
      const message = errorOf(response.body).message ?? `HTTP ${response.status}`;
      log(`Warning: could not turn off Vercel's own deploy-on-push (${message}). A push may also deploy from Vercel's side.`);
    }
  }

  // ------------------------------------------------------------- deploy ----

  async deploy(ctx: VercelContext, input: DeployInput): Promise<DeployResult> {
    const { project, repo, commitSha, deploymentId, log } = input;
    const base = {
      name: project.name,
      project: project.vercelProjectId,
      target: "production",
      meta: {
        orbitopsDeploymentId: deploymentId,
        githubCommitSha: commitSha,
        githubCommitRef: repo.branch,
        githubRepo: repo.fullName,
      },
    };

    if (project.gitLinked) {
      log(`Deploying ${commitSha.slice(0, 7)} from GitHub through Vercel's Git integration.`);
      const response = await vercelRequest<VercelDeploymentBody>(ctx, "POST", "/v13/deployments", {
        query: { skipAutoDetectionConfirmation: 1 },
        body: {
          ...base,
          gitSource: { type: "github", repoId: repo.repoId, ref: repo.branch, sha: commitSha },
        },
      });
      if (response.status >= 200 && response.status < 300) {
        return this.toDeployResult(response.body, "git");
      }
      if (!isGitAccessError(response) || !input.prepareUpload) {
        throw vercelError(response, "starting the deployment");
      }
      log("Vercel cannot read the repo through its GitHub app; uploading files instead.");
    }

    if (!input.prepareUpload) {
      throw new ProviderError(
        "This deploy needs to upload the source, but the GitHub token for it has expired. Deploy again.",
        409,
        "vercel_upload_unavailable",
      );
    }

    const rootDir = await input.prepareUpload();
    const files = await hashFiles(rootDir, await listFiles(rootDir));
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    log(`Prepared ${files.length} files (${formatBytes(totalBytes)}) for upload.`);

    const body = { ...base, files };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await vercelRequest<VercelDeploymentBody>(ctx, "POST", "/v13/deployments", {
        query: { skipAutoDetectionConfirmation: 1 },
        body,
        fetch: { timeoutMs: 120_000 },
      });
      const missing = response.status === 400 ? missingShas(response.body) : [];
      if (missing.length === 0) {
        return this.toDeployResult(expectOk(response, "starting the deployment"), "upload");
      }
      const uploaded = await uploadFiles(ctx, rootDir, files, missing);
      log(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"} Vercel did not already have.`);
    }
    throw new ProviderError(
      "Vercel kept asking for more files after three uploads. Try deploying again.",
      502,
      "vercel_upload_failed",
      { retryable: true },
    );
  }

  private toDeployResult(body: VercelDeploymentBody | undefined, sourceMode: SourceMode): DeployResult {
    if (!body?.id) {
      throw new ProviderError("Vercel accepted the deployment but returned no id.", 502, "vercel_error");
    }
    return {
      providerDeploymentId: body.id,
      url: body.url ? withScheme(body.url) : null,
      inspectorUrl: body.inspectorUrl ?? null,
      sourceMode,
      readyState: normaliseReadyState(body.readyState ?? "QUEUED"),
    };
  }

  // ------------------------------------------------------------ observe ----

  async getStatus(ctx: VercelContext, providerDeploymentId: string, projectName: string): Promise<StatusResult> {
    const response = await vercelRequest<VercelDeploymentBody>(
      ctx,
      "GET",
      `/v13/deployments/${encodeURIComponent(providerDeploymentId)}`,
    );
    const body = expectOk(response, "reading the deployment status");
    const status = normaliseReadyState(body?.readyState);
    return {
      status,
      url: body?.url ? withScheme(body.url) : null,
      productionUrl: status === "live" ? productionUrl(body?.alias ?? [], projectName, body?.url) : null,
      inspectorUrl: body?.inspectorUrl ?? null,
      errorMessage: body?.errorMessage ?? body?.errorCode ?? null,
    };
  }

  /** Build log events after `since` (ms since epoch), oldest first. */
  async getLogs(ctx: VercelContext, providerDeploymentId: string, since?: number | null): Promise<LogLine[]> {
    const response = await vercelRequest<unknown>(
      ctx,
      "GET",
      `/v3/deployments/${encodeURIComponent(providerDeploymentId)}/events`,
      { query: { builds: 1, direction: "forward", limit: -1, since: since ?? undefined } },
    );
    return toLogLines(expectOk(response, "reading the build log"));
  }

  // ------------------------------------------------------------- manage ----

  async cancel(ctx: VercelContext, providerDeploymentId: string): Promise<void> {
    const response = await vercelRequest(
      ctx,
      "PATCH",
      `/v12/deployments/${encodeURIComponent(providerDeploymentId)}/cancel`,
    );
    // 400/409: it already finished, which is what we wanted anyway.
    if (response.status === 400 || response.status === 409 || response.status === 404) return;
    expectOk(response, "cancelling the deployment");
  }

  /** Builds a previous deployment's source again (rollback, Phase 11). */
  async redeploy(ctx: VercelContext, project: KnownProject, providerDeploymentId: string): Promise<DeployResult> {
    const response = await vercelRequest<VercelDeploymentBody>(ctx, "POST", "/v13/deployments", {
      body: { name: project.name, project: project.vercelProjectId, deploymentId: providerDeploymentId, target: "production" },
    });
    return this.toDeployResult(expectOk(response, "redeploying"), project.gitLinked ? "git" : "upload");
  }

  /** Creates or overwrites env vars on the project (Phase 9). */
  async setEnv(ctx: VercelContext, vercelProjectId: string, vars: EnvVarInput[]): Promise<void> {
    if (vars.length === 0) return;
    const response = await vercelRequest(ctx, "POST", `/v10/projects/${encodeURIComponent(vercelProjectId)}/env`, {
      query: { upsert: "true" },
      body: vars.map((v) => ({
        key: v.key,
        value: v.value,
        type: v.type ?? "encrypted",
        target: v.target ?? ["production", "preview"],
      })),
    });
    expectOk(response, "saving environment variables");
  }

  async destroy(ctx: VercelContext, vercelProjectId: string): Promise<void> {
    const response = await vercelRequest(ctx, "DELETE", `/v9/projects/${encodeURIComponent(vercelProjectId)}`);
    if (response.status === 404) return;
    expectOk(response, "deleting the Vercel project");
  }
}

function withScheme(host: string): string {
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

/**
 * The URL to show as "the site": `<project>.vercel.app` when Vercel assigned
 * it, else the shortest *.vercel.app alias, else the deployment's own URL.
 */
export function productionUrl(aliases: string[], projectName: string, deploymentUrl?: string): string | null {
  const preferred = `${projectName}.vercel.app`;
  if (aliases.includes(preferred)) return withScheme(preferred);
  const vercelApp = aliases.filter((a) => a.endsWith(".vercel.app")).sort((a, b) => a.length - b.length);
  const chosen = vercelApp[0] ?? aliases[0] ?? deploymentUrl;
  return chosen ? withScheme(chosen) : null;
}
