import "dotenv/config";
import { resolve } from "node:path";
import { buildApp } from "./app";
import { CallbackClient } from "./callbacks/callback-client";
import { EventOutbox } from "./callbacks/outbox";
import { loadConfig } from "./config";
import { CredentialsService } from "./credentials/credentials.service";
import { prisma } from "./db";
import { DeployQueue } from "./deployments/deploy-queue";
import { DeployRunner } from "./deployments/deploy-runner";
import { DeploymentsService } from "./deployments/deployments.service";
import { TokenVault } from "./deployments/token-vault";
import { setVercelApiBase } from "./vercel/vercel-http";
import { VercelProvider } from "./vercel/vercel.provider";

/**
 * Process entry point: wires the service graph, resumes unfinished work, and
 * listens on 127.0.0.1 only - the main backend is the one client.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  setVercelApiBase(config.vercelApiBase);

  const provider = new VercelProvider();
  const credentials = new CredentialsService(prisma, provider);
  const outbox = new EventOutbox(prisma, new CallbackClient(config.mainApiUrl, config.internalCallbackSecret));
  const tokens = new TokenVault();
  const queue = new DeployQueue(config.deployConcurrency);
  const runner = new DeployRunner(prisma, provider, credentials, outbox, tokens, {
    pollIntervalMs: config.pollIntervalMs,
    deployTimeoutMs: config.deployTimeoutMs,
    workRoot: resolve(process.env.DATA_DIR ?? "./data", "work"),
  });
  const deployments = new DeploymentsService(prisma, queue, tokens, outbox, credentials, provider);

  await prisma.$connect();

  // Undelivered events first, so the main backend hears about earlier progress
  // before anything the resumed runs report.
  const redelivered = await outbox.redeliverPending();
  const { resumed, failed } = await deployments.resumeAll();
  queue.setRunner((job, signal) => runner.run(job, signal));
  if (redelivered || resumed || failed) {
    console.log(`[startup] Re-sent ${redelivered} event batch(es); resumed ${resumed} deploy(s); failed ${failed} that never reached Vercel.`);
  }

  const app = buildApp({
    internalServiceToken: config.internalServiceToken,
    credentials,
    deployments,
    checkDatabase: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
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
  console.log(`[startup] Vercel integration listening on http://${config.host}:${config.port}`);
}

main().catch((error: Error) => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
