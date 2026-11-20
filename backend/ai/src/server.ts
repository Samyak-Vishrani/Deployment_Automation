import "dotenv/config";
import { AnalysisService } from "./analysis/analysis.service";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { prisma } from "./db";
import { OpenAiClient } from "./llm/openai";

/**
 * Process entry point. Listens on 127.0.0.1 only: the main backend is the one
 * client. Nothing runs in the background: an analysis happens only when the
 * user clicks.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const llm = config.openaiApiKey
    ? new OpenAiClient({ apiKey: config.openaiApiKey, baseURL: config.openaiBaseUrl, timeoutMs: config.openaiTimeoutMs }, config.openaiModel)
    : null;
  const analyses = new AnalysisService(prisma, llm, {
    maxInputTokens: config.maxInputTokens,
    maxOutputTokens: config.maxOutputTokens,
    rateHour: config.rateHour,
    rateDay: config.rateDay,
    cacheMinutes: config.cacheMinutes,
  });

  await prisma.$connect();
  const app = buildApp({
    serviceToken: config.serviceToken,
    analyses,
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
  console.log(
    `[startup] AI service listening on http://${config.host}:${config.port} ` +
      (llm ? `(model ${config.openaiModel})` : "(no OPENAI_API_KEY: rule-based answers only)"),
  );
}

main().catch((error: Error) => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
