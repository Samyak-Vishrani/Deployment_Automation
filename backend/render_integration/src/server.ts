import "dotenv/config";
import { CallbackClient } from "@orbitops/integration-common/callback-client";
import { DeployQueue } from "@orbitops/integration-common/deploy-queue";
import { EventOutbox } from "@orbitops/integration-common/outbox";
import { buildApp } from "./app";
import { PrismaPendingStore } from "./callbacks/pending-store";
import { loadConfig } from "./config";
import { CredentialsService } from "./credentials/credentials.service";
import { prisma } from "./db";
import { DeployRunner } from "./deployments/deploy-runner";
import { DeploymentsService } from "./deployments/deployments.service";
import { RenderLogProxy } from "./log-proxy/log-proxy";
import { EnvVault } from "@orbitops/integration-common/env-vault";
import { setRenderApiBase } from "./render/render-http";
import { RenderProvider } from "./render/render.provider";

/**
 * Process entry point: wires the service graph, resumes unfinished work, and
 * listens on 127.0.0.1 only - the main backend is the one client.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  setRenderApiBase(config.renderApiBase);

  const provider = new RenderProvider();
  const credentials = new CredentialsService(prisma, provider);
  const outbox = new EventOutbox(
    new PrismaPendingStore(prisma),
    new CallbackClient(config.mainApiUrl, config.callbackSecret, "render"),
  );
  const vault = new EnvVault();
  const queue = new DeployQueue(config.deployConcurrency);
  const runner = new DeployRunner(prisma, provider, credentials, outbox, vault, {
    pollIntervalMs: config.pollIntervalMs,
    deployTimeoutMs: config.deployTimeoutMs,
  });
  const deployments = new DeploymentsService(prisma, queue, vault, outbox, credentials, provider);

  await prisma.$connect();

  // Undelivered events first, so the main backend hears about earlier progress
  // before anything the resumed runs report.
  const redelivered = await outbox.redeliverPending();
  const { resumed, failed } = await deployments.resumeAll();
  queue.setRunner((job, signal) => runner.run(job, signal));
  if (redelivered || resumed || failed) {
    console.log(
      `[startup] Re-sent ${redelivered} event batch(es); resumed ${resumed} deploy(s); failed ${failed} that never reached Render.`,
    );
  }

  const app = buildApp({
    serviceToken: config.serviceToken,
    credentials,
    deployments,
    checkDatabase: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
    logProxy: new RenderLogProxy(prisma, credentials),
    logsProxyToken: config.logsProxyToken ?? undefined,
    logger: process.env.LOG_REQUESTS === "1",
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal}; stopping. Running deploys resume on the next start.`);
    await app.close().catch(() => undefined);
    await queue.drain();
    outbox.stop();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  console.log(`[startup] Render integration listening on http://${config.host}:${config.port}`);
}

main().catch((error: Error) => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
