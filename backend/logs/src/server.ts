import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { tailDocker } from "./runtime/docker-tail";
import { ProxyClient } from "./runtime/proxy-client";
import { tailRender } from "./runtime/render-tail";
import { RuntimeSessions } from "./runtime/runtime-session";
import { dockerSnapshot, renderSnapshot, VERCEL_SNAPSHOT } from "./runtime/snapshot";
import { tailVercel } from "./runtime/vercel-tail";
import { LogStore } from "./store/log-store";

/**
 * Process entry point. Listens on 127.0.0.1 only: the main backend is the one
 * client. Nothing to resume on boot: build logs are appended as the backend
 * sends them, and runtime streams only exist while someone watches.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });

  const store = new LogStore({ dataDir: config.dataDir, legacyDir: config.legacyDir, maxLogBytes: config.maxLogBytes });
  const proxy = new ProxyClient({ vercelUrl: config.vercelServiceUrl, renderUrl: config.renderServiceUrl, token: config.proxyToken });
  const sessions = new RuntimeSessions({
    maxPerUser: config.maxStreamsPerUser,
    maxMs: config.runtimeMaxMs,
    idleMs: config.runtimeIdleMs,
  });

  const app = buildApp({
    serviceToken: config.serviceToken,
    store,
    runtime: {
      sessions,
      tailers: {
        vercel: (userId, componentId, signal) => tailVercel(proxy, userId, componentId, { signal }),
        render: (userId, componentId, opts, signal) =>
          tailRender(proxy, userId, componentId, { ...opts, pollMs: config.renderPollMs, signal }),
        docker: (containerName, opts, signal) => tailDocker(containerName, { ...opts, signal }),
      },
      snapshots: {
        render: (userId, componentId, opts, signal) => renderSnapshot(proxy, userId, componentId, { ...opts, signal }),
        vercel: () => VERCEL_SNAPSHOT,
        docker: (containerName, opts) => dockerSnapshot(containerName, opts),
      },
    },
    logger: process.env.LOG_REQUESTS === "1",
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal}; closing ${sessions.openCount} live stream(s).`);
    sessions.closeAll();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  console.log(`[startup] Logs service listening on http://${config.host}:${config.port} (data: ${config.dataDir})`);
}

main().catch((error: Error) => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
