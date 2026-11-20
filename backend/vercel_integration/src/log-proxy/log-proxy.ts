import { ProviderError } from "@orbitops/integration-common/provider-error";
import type { CredentialsService } from "../credentials/credentials.service";
import type { Db } from "../db";
import { vercelUrl } from "../vercel/vercel-http";

/** The header backend/logs sends: LOGS_PROXY_TOKEN, valid on /log-proxy routes only. */
export const LOGS_PROXY_HEADER = "x-logs-token";

/**
 * Read-only access to a component's runtime logs for backend/logs (Phase 12).
 *
 * The logs service holds all the log code (parsing, de-duplication,
 * sessions); this only adds the user's Vercel token, which never leaves this
 * service, and pipes Vercel's response back unchanged. The upstream URL is
 * built here from stored ids, never taken from the caller.
 */
export class VercelLogProxy {
  constructor(
    private readonly db: Db,
    private readonly credentials: Pick<CredentialsService, "getToken" | "markInvalid">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Opens Vercel's runtime-log stream of the component's live production deployment. */
  async openRuntime(
    userId: string,
    componentId: string,
    signal: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array>; vercelDeploymentId: string }> {
    const project = await this.db.vercelProject.findUnique({ where: { componentId } });
    if (!project || project.userId !== userId) {
      throw new ProviderError("This component has no Vercel project yet. Deploy it first.", 404, "not_deployed");
    }
    const live = await this.db.vercelDeployment.findFirst({
      where: { componentId, userId, state: "live", vercelDeploymentId: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    if (!live?.vercelDeploymentId) {
      throw new ProviderError("Nothing of this component is live on Vercel yet. Deploy it first.", 404, "not_deployed");
    }

    const scope = await this.credentials.getToken(userId);
    const url = vercelUrl(
      `/v1/projects/${encodeURIComponent(project.vercelProjectId)}/deployments/${encodeURIComponent(live.vercelDeploymentId)}/runtime-logs`,
      {},
      scope.teamId,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${scope.token}`, accept: "application/stream+json", "user-agent": "orbitops-vercel-integration" },
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderError(`Could not reach Vercel (${(error as Error).message}).`, 502, "vercel_unavailable", { retryable: true });
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) {
        await this.credentials.markInvalid(userId);
        throw new ProviderError("Vercel rejected the saved token. Reconnect Vercel in Settings.", 412, "vercel_token_invalid", { invalidToken: true });
      }
      if (response.status === 403) throw new ProviderError("The Vercel token cannot read this project's logs.", 403, "vercel_forbidden");
      if (response.status === 404 || response.status === 410) {
        throw new ProviderError("Vercel has no runtime logs for this deployment (it may have been removed).", 404, "not_deployed");
      }
      if (response.status === 429) throw new ProviderError("Vercel rate-limited the log stream; try again shortly.", 429, "vercel_rate_limited", { retryable: true });
      throw new ProviderError(`Vercel answered ${response.status} for the runtime logs.`, 502, "vercel_unavailable", { retryable: true });
    }
    return { body: response.body, vercelDeploymentId: live.vercelDeploymentId };
  }
}
