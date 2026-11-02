import type { RenderDeployment, RenderService } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { redact } from "../common/redact";
import type { Db } from "../db";
import { abortableSleep } from "../http/provider-fetch";
import { ProviderError } from "../http/provider-error";
import type { CredentialsService } from "../credentials/credentials.service";
import type { EventOutbox } from "../callbacks/outbox";
import { describeFailure, hintFor } from "../render/error-hints";
import type { RenderContext } from "../render/render-http";
import type { KnownService, RenderProvider } from "../render/render.provider";
import { isTerminal, type NormalisedStatus, type ProviderEvent, type StoredDeployInput } from "../types";
import type { AbortReason, DeployJob } from "./deploy-queue";
import type { EnvVault } from "./env-vault";

export interface RunnerOptions {
  pollIntervalMs: number;
  deployTimeoutMs: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Health-probe attempts after "live" (tests set 1). */
  healthAttempts?: number;
}

type Provider = Pick<
  RenderProvider,
  "ensureService" | "deploy" | "getStatus" | "getLogs" | "cancel" | "getServiceUrl" | "probeHealth"
>;
type Credentials = Pick<CredentialsService, "getKey" | "markInvalid">;
type Outbox = Pick<EventOutbox, "push" | "drain">;
type Log = (text: string, stream?: "info" | "stdout" | "stderr") => void;

const MAX_POLL_INTERVAL_MS = 10_000;
/** Recent log lines kept to find the cause of a failure. */
const RECENT_LINES = 80;

export function toKnownService(row: RenderService | null): KnownService | null {
  if (!row) return null;
  return {
    renderServiceId: row.renderServiceId,
    name: row.name,
    ownerId: row.ownerId,
    region: row.region,
    plan: row.plan,
    runtime: row.runtime,
    url: row.url,
    dashboardUrl: row.dashboardUrl,
    settingsHash: row.settingsHash,
    envHash: row.envHash,
    managedEnvKeys: Array.isArray(row.managedEnvKeys) ? (row.managedEnvKeys as string[]) : [],
  };
}

/**
 * Runs one Render deploy end to end, reporting every step to the main backend
 * through the outbox:
 *
 *   ensure service (+ env sync) → deploy the exact commit → poll status + logs
 *   until live / failed / canceled → health probe → terminal event
 *
 * State is written to RenderDeployment as it changes. Once Render has a deploy
 * id, resuming after a restart is just polling again.
 */
export class DeployRunner {
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly db: Db,
    private readonly provider: Provider,
    private readonly credentials: Credentials,
    private readonly outbox: Outbox,
    private readonly vault: Pick<EnvVault, "take">,
    private readonly options: RunnerOptions,
  ) {
    this.sleep = options.sleep ?? abortableSleep;
  }

  async run(job: DeployJob, signal: AbortSignal): Promise<void> {
    const row = await this.db.renderDeployment.findUnique({ where: { deploymentId: job.deploymentId } });
    if (!row || isTerminal(row.state)) return;

    const input = row.input as unknown as StoredDeployInput;
    const envVars = this.vault.take(row.deploymentId);
    // Every env value is a secret as far as the log is concerned.
    const secrets: string[] = (envVars ?? []).map((v) => v.value);

    const emit = (event: ProviderEvent) => this.outbox.push(row.deploymentId, event);
    const log: Log = (text, stream = "info") =>
      emit({ type: "logs", lines: [{ at: Date.now(), stream, text: redact(text, secrets) }] });

    let ctx: RenderContext | undefined;
    let serviceId: string | null = null;
    let deployId = row.renderDeployId;

    try {
      const scope = await this.credentials.getKey(row.userId);
      secrets.push(scope.apiKey);
      ctx = { apiKey: scope.apiKey, signal };

      let service = await this.db.renderService.findUnique({ where: { componentId: input.component.id } });

      if (!deployId) {
        if (envVars === undefined) {
          throw new ProviderError(
            "This deploy was interrupted before it reached Render, and its env vars are no longer held. Deploy again.",
            409,
            "render_interrupted",
          );
        }
        await this.setState(row.deploymentId, "deploying", emit);
        log(`==> Preparing Render service for ${input.component.name}`);

        const known = toKnownService(service);
        const ensured = await this.provider.ensureService(
          ctx,
          known,
          input.component,
          input.repo,
          { ownerId: known?.ownerId ?? scope.ownerId, region: scope.region, plan: scope.plan },
          envVars,
          log,
        );
        serviceId = ensured.renderServiceId;

        // Stored before deploying: if this run dies now, the next one finds the
        // service instead of creating a second one.
        const serviceData = {
          userId: row.userId,
          renderServiceId: ensured.renderServiceId,
          name: ensured.name,
          ownerId: ensured.ownerId,
          region: ensured.region,
          plan: ensured.plan,
          runtime: ensured.runtime,
          url: ensured.url,
          dashboardUrl: ensured.dashboardUrl,
          settingsHash: ensured.settingsHash,
          envHash: ensured.envHash,
          managedEnvKeys: ensured.managedEnvKeys as unknown as Prisma.InputJsonValue,
        };
        service = await this.db.renderService.upsert({
          where: { componentId: input.component.id },
          create: { componentId: input.component.id, ...serviceData },
          update: serviceData,
        });
        emit({
          type: "resource",
          componentId: input.component.id,
          providerResourceId: ensured.renderServiceId,
          projectName: ensured.name,
        });

        log(`==> Deploying ${input.commitSha.slice(0, 7)} of ${input.repo.fullName}@${input.repo.branch} to Render`);
        const result = await this.provider.deploy(ctx, ensured.renderServiceId, input.commitSha, ensured.initialDeployId, log);
        deployId = result.providerDeploymentId;
        await this.db.renderDeployment.update({
          where: { deploymentId: row.deploymentId },
          data: { renderDeployId: deployId, url: ensured.url, dashboardUrl: result.dashboardUrl },
        });
        emit({
          type: "deployment",
          providerDeploymentId: deployId,
          sourceMode: "git",
          url: ensured.url,
          inspectorUrl: result.dashboardUrl,
        });
        log(`Render dashboard: ${result.dashboardUrl}`);
      } else {
        if (!service) {
          throw new ProviderError("The Render service for this deploy is no longer known. Deploy again.", 409, "render_error");
        }
        serviceId = service.renderServiceId;
        log("==> Resuming after a restart of the Render integration service; Render kept building meanwhile.");
      }

      log("==> Waiting for Render's build");
      await this.poll(row, ctx, service!, deployId, input, emit, log, secrets);
    } catch (error) {
      if (signal.aborted) {
        await this.onAbort(row, signal.reason as AbortReason, serviceId, deployId, ctx, emit, log);
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
    row: RenderDeployment,
    ctx: RenderContext,
    service: RenderService,
    deployId: string,
    input: StoredDeployInput,
    emit: (event: ProviderEvent) => void,
    log: Log,
    secrets: string[],
  ): Promise<void> {
    const deadline = row.createdAt.getTime() + this.options.deployTimeoutMs;
    let lastState = (await this.currentState(row.deploymentId)) as NormalisedStatus;
    // Start at this deploy's request time, so a fresh service's older logs (or a
    // previous deploy's) are not replayed.
    let cursor = row.lastLogAt ?? row.createdAt.toISOString();
    const seen = new Set<string>();
    const recent: string[] = [];
    let delay = this.options.pollIntervalMs;
    let transientFailures = 0;

    for (;;) {
      try {
        const status = await this.provider.getStatus(ctx, service.renderServiceId, deployId);
        const { lines, cursor: next } = await this.provider.getLogs(ctx, service.ownerId, service.renderServiceId, cursor);
        transientFailures = 0;

        const fresh = lines.filter((line) => !seen.has(line.id));
        for (const line of fresh) {
          seen.add(line.id);
          recent.push(line.text);
        }
        recent.splice(0, Math.max(0, recent.length - RECENT_LINES));
        if (fresh.length > 0) {
          emit({
            type: "logs",
            lines: fresh.map((line) => ({ at: line.at, stream: line.stream, text: redact(line.text, secrets) })),
          });
        }
        if (next && next !== cursor) {
          cursor = next;
          await this.db.renderDeployment.update({ where: { deploymentId: row.deploymentId }, data: { lastLogAt: cursor } });
        }

        if (status.status !== lastState && !isTerminal(status.status)) {
          lastState = status.status;
          await this.setState(row.deploymentId, status.status, emit);
        }

        if (status.status === "live") {
          const url = service.url ?? (await this.provider.getServiceUrl(ctx, service.renderServiceId));
          if (url) {
            if (url !== service.url) {
              await this.db.renderService.update({ where: { componentId: service.componentId }, data: { url } });
            }
            await this.provider.probeHealth(url, input.component.healthCheckPath, log, {
              attempts: this.options.healthAttempts,
              signal: ctx.signal,
            });
          }
          await this.finish(row.deploymentId, "live", { productionUrl: url }, emit, log);
          return;
        }
        if (status.status === "failed" || status.status === "cancelled") {
          const hint = status.status === "failed" ? hintFor(recent) : null;
          const errorMessage =
            status.status === "failed"
              ? `${describeFailure(status.rawStatus)}${hint ? ` ${hint}` : " See the build log above."}`
              : "Cancelled on Render.";
          await this.finish(row.deploymentId, status.status, { errorMessage }, emit, log);
          return;
        }
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.retryable || ++transientFailures > 10) throw error;
        log(`Render did not answer (${error.message}); retrying.`);
      }

      if (Date.now() >= deadline) {
        const minutes = Math.round(this.options.deployTimeoutMs / 60000);
        throw new ProviderError(
          `Render did not finish within ${minutes} minutes; see the Render dashboard link above.`,
          504,
          "render_timeout",
        );
      }
      await this.sleep(delay, ctx.signal);
      delay = Math.min(MAX_POLL_INTERVAL_MS, Math.round(delay * 1.5));
    }
  }

  private async onAbort(
    row: RenderDeployment,
    reason: AbortReason,
    serviceId: string | null,
    deployId: string | null,
    ctx: RenderContext | undefined,
    emit: (event: ProviderEvent) => void,
    log: Log,
  ): Promise<void> {
    if (reason === "shutdown") {
      // Leave Render building and the row unfinished: the next start resumes it.
      log("==> The Render integration service is restarting; this deploy will resume.");
      return;
    }
    if (serviceId && deployId && ctx) {
      try {
        await this.provider.cancel({ ...ctx, signal: undefined }, serviceId, deployId);
        log("Cancelled the deploy on Render.");
      } catch (error) {
        log(`Could not cancel on Render: ${(error as Error).message}`, "stderr");
      }
    }
    await this.finish(row.deploymentId, "cancelled", { errorMessage: "Cancelled by user." }, emit, log);
  }

  private async currentState(deploymentId: string): Promise<string> {
    const row = await this.db.renderDeployment.findUnique({ where: { deploymentId }, select: { state: true } });
    return row?.state ?? "queued";
  }

  private async setState(
    deploymentId: string,
    state: NormalisedStatus,
    emit: (event: ProviderEvent) => void,
  ): Promise<void> {
    await this.db.renderDeployment.update({ where: { deploymentId }, data: { state } });
    emit({ type: "status", providerStatus: state });
  }

  private async finish(
    deploymentId: string,
    state: "live" | "failed" | "cancelled",
    details: { productionUrl?: string | null; errorMessage?: string | null },
    emit: (event: ProviderEvent) => void,
    log: Log,
  ): Promise<void> {
    await this.db.renderDeployment.update({
      where: { deploymentId },
      data: {
        state,
        ...(details.productionUrl ? { url: details.productionUrl } : {}),
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
