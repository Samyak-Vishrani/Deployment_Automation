import "dotenv/config";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { CredentialsService } from "./credentials/credentials.service";
import { DatabasesService } from "./databases/databases.service";
import { prisma } from "./db";
import { setNeonApiBase } from "./neon/neon-http";
import { NeonProvider } from "./neon/neon.provider";

/**
 * Process entry point: wires the service graph and listens on 127.0.0.1 only -
 * the main backend is the one client.
 *
 * Nothing runs in the background: a database left "provisioning" by a restart
 * simply carries on at its next POST /databases.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  setNeonApiBase(config.neonApiBase);

  const neon = new NeonProvider();
  const credentials = new CredentialsService(prisma, neon, {
    regionId: config.defaultRegion,
    pgVersion: config.defaultPgVersion,
  });
  const databases = new DatabasesService(prisma, neon, credentials, {
    provisionTimeoutMs: config.provisionTimeoutMs,
  });

  await prisma.$connect();

  const app = buildApp({
    serviceToken: config.serviceToken,
    credentials,
    databases,
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
    console.log(`[shutdown] ${signal}; stopping.`);
    await app.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  console.log(`[startup] Neon DB integration listening on http://${config.host}:${config.port}`);
}

main().catch((error: Error) => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
