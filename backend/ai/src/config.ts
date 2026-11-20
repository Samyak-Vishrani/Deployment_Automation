/**
 * Environment for the AI service, read once and validated so a missing secret
 * fails at startup with a list of what to set.
 *
 * OPENAI_API_KEY is optional on purpose: without it every analysis is
 * rule-based, which still names the likely problem and the steps to fix it.
 */

import { baseUrl, positiveInt, requireEnv, requireSecretLength } from "@orbitops/integration-common/config-helpers";

export { MissingEnvError } from "@orbitops/integration-common/config-helpers";

export interface AiConfig {
  host: string;
  port: number;
  /** Expected in x-internal-token from the main backend. */
  serviceToken: string;
  openaiApiKey: string | null;
  openaiModel: string;
  openaiBaseUrl: string | null;
  openaiTimeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  rateHour: number;
  rateDay: number;
  cacheMinutes: number;
}

const FOLDER = "ai";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  requireEnv(env, ["DATABASE_URL", "AI_SERVICE_TOKEN"], FOLDER);
  requireSecretLength(env, ["AI_SERVICE_TOKEN"]);

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: positiveInt(env.PORT, 3006),
    serviceToken: env.AI_SERVICE_TOKEN!.trim(),
    openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
    openaiModel: env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    openaiBaseUrl: env.OPENAI_BASE_URL?.trim() ? baseUrl(env.OPENAI_BASE_URL, "") : null,
    openaiTimeoutMs: positiveInt(env.OPENAI_TIMEOUT_MS, 45_000),
    maxInputTokens: positiveInt(env.AI_MAX_INPUT_TOKENS, 24_000),
    maxOutputTokens: positiveInt(env.AI_MAX_OUTPUT_TOKENS, 2_500),
    rateHour: positiveInt(env.AI_RATE_HOUR, 20),
    rateDay: positiveInt(env.AI_RATE_DAY, 100),
    cacheMinutes: positiveInt(env.AI_CACHE_MINUTES, 10),
  };
}
