import { join } from "node:path";
import type { VercelDeployment } from "@prisma/client";
import { removeDir } from "../common/fs-utils";
import { redact } from "../common/redact";
import type { Db } from "../db";
import { downloadRepoAt } from "../github/source-archive";
import { abortableSleep } from "../http/provider-fetch";
import { ProviderError } from "../http/provider-error";
import type { CredentialsService } from "../credentials/credentials.service";
import type { EventOutbox } from "../callbacks/outbox";
import { isTerminal, type NormalisedStatus, type ProviderEvent, type StoredDeployInput } from "../types";
import type { VercelContext } from "../vercel/vercel-http";
import type { VercelProvider } from "../vercel/vercel.provider";
import type { AbortReason, DeployJob } from "./deploy-queue";
import type { TokenVault } from "./token-vault";

export interface RunnerOptions {
  pollIntervalMs: number;
  deployTimeoutMs: number;
  /** Where source is extracted for the upload fallback. */
  workRoot: string;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  downloadSource?: typeof downloadRepoAt;
}

type Provider = Pick<VercelProvider, "ensureProject" | "deploy" | "getStatus" | "getLogs" | "cancel">;
type Credentials = Pick<CredentialsService, "getToken" | "markInvalid">;
type Outbox = Pick<EventOutbox, "push" | "drain">;

const MAX_POLL_INTERVAL_MS = 10_000;

/**
 * Runs one Vercel deploy end to end, reporting every step to the main backend
 * through the outbox:
 *
 *   ensure project → deploy (Git source, or upload) → poll status + build log
 *   until READY / ERROR / CANCELED → terminal event
 *
 * State is written to VercelDeployment as it changes, which is what lets a run
 * interrupted by a restart pick up where it was: once Vercel has a deployment
 * id, resuming is just polling again.
 */
export class DeployRunner {
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly download: typeof downloadRepoAt;

  constructor(
    private readonly db: Db,
    private readonly provider: Provider,
    private readonly credentials: Credentials,
    private readonly outbox: Outbox,
    private readonly tokens: Pick<TokenVault, "take">,
    private readonly options: RunnerOptions,
  ) {
    this.sleep = options.sleep ?? abortableSleep;
    this.download = options.downloadSource ?? downloadRepoAt;
  }

  async run(job: DeployJob, signal: AbortSignal): Promise<void> {
    const row = await this.db.vercelDeployment.findUnique({ where: { deploymentId: job.deploymentId } });
    if (!row || isTerminal(row.state)) return;

    const input = row.input as unknown as StoredDeployInput;
    const secrets: string[] = [];
    const githubToken = this.tokens.take(row.deploymentId);
    if (githubToken) secrets.push(githubToken);

    const emit = (event: ProviderEvent) => this.outbox.push(row.deploymentId, event);
    const log = (text: string, stream: "info" | "stdout" | "stderr" = "info") =>
      emit({ type: "logs", lines: [{ at: Date.now(), stream, text: redact(text, secrets) }] });

    let ctx: VercelContext | undefined;
    let vercelDeploymentId = row.vercelDeploymentId;

    try {
      const scope = await this.credentials.getToken(row.userId);
      secrets.push(scope.token);
      ctx = { token: scope.token, teamId: scope.teamId, signal };

      let projectName: string;
      if (!vercelDeploymentId) {
        await this.setState(row.deploymentId, "deploying", emit);
        log(`==> Preparing Vercel project for ${input.component.name}`);

        const known = await this.db.vercelProject.findUnique({ where: { componentId: input.component.id } });
        const project = await this.provider.ensureProject(ctx, known, input.component, input.repo, log);
        projectName = project.name;

        // Stored before deploying: if this run dies now, the next one finds the
        // project instead of creating a second one.
        const projectData = {
          userId: row.userId,
          vercelProjectId: project.vercelProjectId,
          name: project.name,
          teamId: scope.teamId,
          gitLinked: project.gitLinked,
          settingsHash: project.settingsHash,
        };
        await this.db.vercelProject.upsert({
          where: { componentId: input.component.id },
          create: { componentId: input.component.id, ...projectData },
          update: projectData,
        });
        emit({
          type: "resource",
          componentId: input.component.id,
          providerResourceId: project.vercelProjectId,
          projectName: project.name,
        });

        log(`==> Deploying ${input.commitSha.slice(0, 7)} of ${input.repo.fullName}@${input.repo.branch} to Vercel`);
        const workDir = join(this.options.workRoot, row.deploymentId);
        try {
          const result = await this.provider.deploy(ctx, {
            project,
            repo: input.repo,
            commitSha: input.commitSha,
            deploymentId: row.deploymentId,
            log,
            prepareUpload: githubToken
              ? async () => {
                  log("Downloading the source from GitHub for upload.");
                  await this.download(input.repo.fullName, input.commitSha, githubToken, workDir, signal);
                  return workDir;
                }
              : undefined,
          });
          vercelDeploymentId = result.providerDeploymentId;
          await this.db.vercelDeployment.update({
            where: { deploymentId: row.deploymentId },
            data: {
              vercelDeploymentId,
              sourceMode: result.sourceMode,
              url: result.url,
              inspectorUrl: result.inspectorUrl,
            },
          });
          emit({
            type: "deployment",
            providerDeploymentId: result.providerDeploymentId,
            sourceMode: result.sourceMode,
            url: result.url,
            inspectorUrl: result.inspectorUrl,
          });
          if (result.inspectorUrl) log(`Vercel dashboard: ${result.inspectorUrl}`);
        } finally {
          await removeDir(workDir).catch(() => undefined);
        }
      } else {
        const project = await this.db.vercelProject.findUnique({ where: { componentId: input.component.id } });
        projectName = project?.name ?? input.component.name;
        log("==> Resuming after a restart of the Vercel integration service; Vercel kept building meanwhile.");
      }

      log("==> Waiting for Vercel's build");
      await this.poll(row, ctx, vercelDeploymentId, projectName, emit, log, secrets);
    } catch (error) {
      if (signal.aborted) {
        await this.onAbort(row, signal.reason as AbortReason, vercelDeploymentId, ctx, emit, log);
        return;
      }
      if (error instanceof ProviderError && error.invalidToken) {
        await this.credentials.markInvalid(row.userId);
      }
      const message = redact(error instanceof Error ? error.message : String(error), secrets);
      log(`Deploy failed: ${message}`, "stderr");
      await this.finish(row.deploymentId, "failed", { errorMessage: message }, emit, log);
    }
  }

  private async poll(
    row: VercelDeployment,
    ctx: VercelContext,
    vercelDeploymentId: string,
    projectName: string,
    emit: (event: ProviderEvent) => void,
    log: (text: string, stream?: "info" | "stdout" | "stderr") => void,
    secrets: string[],
  ): Promise<void> {
    const deadline = row.createdAt.getTime() + this.options.deployTimeoutMs;
    let lastState = (await this.currentState(row.deploymentId)) as NormalisedStatus;
    let lastEventAt = row.lastEventAt ?? null;
    const seen = new Set<string>();
    let delay = this.options.pollIntervalMs;
    let transientFailures = 0;

    for (;;) {
      try {
        const status = await this.provider.getStatus(ctx, vercelDeploymentId, projectName);
        const lines = await this.provider.getLogs(ctx, vercelDeploymentId, lastEventAt);
        transientFailures = 0;

        const fresh = lines.filter((line) => !seen.has(line.id));
        for (const line of fresh) seen.add(line.id);
        if (fresh.length > 0) {
          emit({
            type: "logs",
            lines: fresh.map((line) => ({ at: line.at, stream: line.stream, text: redact(line.text, secrets) })),
          });
          const newest = Math.max(...fresh.map((line) => line.at));
          if (Number.isFinite(newest) && newest > (lastEventAt ?? 0)) {
            lastEventAt = newest;
            await this.db.vercelDeployment.update({
              where: { deploymentId: row.deploymentId },
              data: { lastEventAt },
            });
          }
        }

        if (status.status !== lastState && !isTerminal(status.status)) {
          lastState = status.status;
          await this.setState(row.deploymentId, status.status, emit);
        }
        if (status.status === "live") {
          await this.finish(row.deploymentId, "live", { productionUrl: status.productionUrl ?? status.url }, emit, log);
          return;
        }
        if (status.status === "failed" || status.status === "cancelled") {
          await this.finish(
            row.deploymentId,
            status.status,
            {
              errorMessage:
                status.status === "failed"
                  ? `Vercel build failed${status.errorMessage ? `: ${status.errorMessage}` : "."}`
                  : "Cancelled on Vercel.",
            },
            emit,
            log,
          );
          return;
        }
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.retryable || ++transientFailures > 10) throw error;
        log(`Vercel did not answer (${error.message}); retrying.`);
      }

      if (Date.now() >= deadline) {
        const minutes = Math.round(this.options.deployTimeoutMs / 60000);
        throw new ProviderError(
          `Vercel did not finish within ${minutes} minutes; see the Vercel dashboard link above.`,
          504,
          "vercel_timeout",
        );
      }
      await this.sleep(delay, ctx.signal);
      delay = Math.min(MAX_POLL_INTERVAL_MS, Math.round(delay * 1.5));
    }
  }

  private async onAbort(
    row: VercelDeployment,
    reason: AbortReason,
    vercelDeploymentId: string | null,
    ctx: VercelContext | undefined,
    emit: (event: ProviderEvent) => void,
    log: (text: string, stream?: "info" | "stdout" | "stderr") => void,
  ): Promise<void> {
    if (reason === "shutdown") {
      // Leave Vercel building and the row unfinished: the next start resumes it.
      log("==> The Vercel integration service is restarting; this deploy will resume.");
      return;
    }
    if (vercelDeploymentId && ctx) {
      try {
        await this.provider.cancel({ ...ctx, signal: undefined }, vercelDeploymentId);
        log("Cancelled the deployment on Vercel.");
      } catch (error) {
        log(`Could not cancel on Vercel: ${(error as Error).message}`, "stderr");
      }
    }
    await this.finish(row.deploymentId, "cancelled", { errorMessage: "Cancelled by user." }, emit, log);
  }

  private async currentState(deploymentId: string): Promise<string> {
    const row = await this.db.vercelDeployment.findUnique({ where: { deploymentId }, select: { state: true } });
    return row?.state ?? "queued";
  }

  private async setState(
    deploymentId: string,
    state: NormalisedStatus,
    emit: (event: ProviderEvent) => void,
  ): Promise<void> {
    await this.db.vercelDeployment.update({ where: { deploymentId }, data: { state } });
    emit({ type: "status", providerStatus: state });
  }

  private async finish(
    deploymentId: string,
    state: "live" | "failed" | "cancelled",
    details: { productionUrl?: string | null; errorMessage?: string | null },
    emit: (event: ProviderEvent) => void,
    log: (text: string, stream?: "info" | "stdout" | "stderr") => void,
  ): Promise<void> {
    await this.db.vercelDeployment.update({
      where: { deploymentId },
      data: {
        state,
        productionUrl: details.productionUrl ?? null,
        errorMessage: details.errorMessage ?? null,
        finishedAt: new Date(),
      },
    });
    if (state === "live" && details.productionUrl) log(`==> Live at ${details.productionUrl}`);
    emit({ type: "status", providerStatus: state, ...(details.errorMessage ? { errorMessage: details.errorMessage } : {}) });
    emit({ type: "terminal", status: state, productionUrl: details.productionUrl ?? null, errorMessage: details.errorMessage ?? null });
    await this.outbox.drain(deploymentId);
  }
}
