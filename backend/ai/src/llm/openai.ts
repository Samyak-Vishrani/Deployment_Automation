import OpenAI from "openai";
import { ProviderError } from "@orbitops/integration-common/provider-error";
import { redact } from "@orbitops/integration-common/redact";

export interface CompletionInput {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface CompletionOutput {
  json: unknown;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

/** What the analysis service needs from a model; stubbed in tests. */
export interface LlmClient {
  readonly model: string;
  complete(input: CompletionInput): Promise<CompletionOutput>;
}

/**
 * OpenAI Chat Completions with Structured Outputs (a strict JSON schema), so
 * the answer always parses into the AnalysisResult shape. gpt-4o-mini by
 * default (OPENAI_MODEL).
 *
 * Errors become ProviderErrors with a stable code; the API key never appears
 * in a message (the SDK's messages are redacted all the same).
 */
export class OpenAiClient implements LlmClient {
  private readonly client: OpenAI;

  constructor(
    options: { apiKey: string; baseURL?: string | null; timeoutMs: number },
    readonly model: string,
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      timeout: options.timeoutMs,
      maxRetries: 2,
    });
  }

  async complete(input: CompletionInput): Promise<CompletionOutput> {
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        max_tokens: input.maxTokens,
        response_format: {
          type: "json_schema",
          json_schema: { name: "orbitops_analysis", strict: true, schema: input.schema },
        },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      });
    } catch (error) {
      throw toProviderError(error);
    }

    const choice = completion.choices[0];
    const message = choice?.message as (OpenAI.Chat.Completions.ChatCompletionMessage & { refusal?: string | null }) | undefined;
    if (message?.refusal) {
      throw new ProviderError(`The model declined: ${redact(message.refusal).slice(0, 200)}`, 502, "openai_bad_response");
    }
    if (choice?.finish_reason === "length") {
      throw new ProviderError("The model's answer was cut off (output limit).", 502, "openai_bad_response", { retryable: true });
    }
    const content = message?.content;
    if (!content) throw new ProviderError("The model returned an empty answer.", 502, "openai_bad_response");

    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new ProviderError("The model returned text that is not JSON.", 502, "openai_bad_response");
    }
    return {
      json,
      model: completion.model ?? this.model,
      usage: { promptTokens: completion.usage?.prompt_tokens ?? 0, completionTokens: completion.usage?.completion_tokens ?? 0 },
    };
  }
}

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError("OpenAI did not answer in time.", 504, "openai_unavailable", { retryable: true });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ProviderError("Could not reach OpenAI.", 503, "openai_unavailable", { retryable: true });
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    const detail = redact(String(error.message ?? "")).slice(0, 200);
    if (status === 401) return new ProviderError("OpenAI rejected OPENAI_API_KEY.", 502, "openai_key_invalid");
    if (status === 403) return new ProviderError(`OpenAI refused the request (${detail}).`, 502, "openai_forbidden");
    if (status === 404) return new ProviderError(`The OpenAI model is not available to this key (${detail}).`, 502, "openai_model_unavailable");
    if (status === 429) {
      const quota = /quota|billing/i.test(detail);
      return new ProviderError(
        quota ? "The OpenAI account has no quota left (billing)." : "OpenAI rate-limited the request.",
        429,
        quota ? "openai_quota_exceeded" : "openai_rate_limited",
        { retryable: !quota },
      );
    }
    if (status >= 500) return new ProviderError("OpenAI had a server error.", 503, "openai_unavailable", { retryable: true });
    return new ProviderError(`OpenAI refused the request (${status}: ${detail}).`, 502, "openai_bad_request");
  }
  return new ProviderError(`The OpenAI call failed (${redact((error as Error)?.message ?? String(error)).slice(0, 200)}).`, 502, "openai_unavailable");
}
