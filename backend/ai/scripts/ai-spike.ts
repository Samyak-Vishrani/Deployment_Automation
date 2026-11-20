/**
 * Step 0 of PLAN_PHASE_13: does OpenAI answer, with Structured Outputs, for
 * YOUR key, and what does one analysis cost?
 *
 *   OPENAI_API_KEY=... npm run spike          (or with the key in backend/ai/.env)
 *
 * Sends one small fixed bundle (a Render backend failing with "No open ports
 * detected") through the real pipeline: rules → budget → prompt → OpenAI →
 * validation. Prints latency, tokens, and the parsed answer. Writes nothing.
 */
import "dotenv/config";
import { fitBundle } from "../src/budget/fit";
import { OpenAiClient } from "../src/llm/openai";
import { systemPrompt } from "../src/prompts/system";
import { userPrompt } from "../src/prompts/user";
import { classify } from "../src/rules/classify";
import { ANALYSIS_SCHEMA } from "../src/schema";
import { sampleBundle } from "../src/test-support/bundles";
import { validateResult } from "../src/validate";

const key = process.env.OPENAI_API_KEY?.trim();
if (!key) {
  console.error("Set OPENAI_API_KEY (in backend/ai/.env or the environment).");
  process.exit(1);
}

async function main() {
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const bundle = sampleBundle("port");
  const hypotheses = classify(bundle);
  const fitted = fitBundle(bundle, hypotheses, 21_000);
  const client = new OpenAiClient({ apiKey: key!, timeoutMs: 60_000 }, model);
  const started = Date.now();
  const out = await client.complete({
    system: systemPrompt("project"),
    user: userPrompt({ scope: "project", bundle: fitted.bundle, targetComponentId: null, hypotheses, timeline: "", budgetNotes: [], question: null }),
    schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2500,
  });
  const { result, warnings } = validateResult(out.json, fitted.bundle);
  console.log(`model ${out.model}, ${Date.now() - started} ms, prompt ${out.usage.promptTokens} tokens, completion ${out.usage.completionTokens} tokens`);
  console.log(`verdict: ${result.verdict}\nsummary: ${result.summary}`);
  for (const p of result.problems) console.log(`- problem ${p.id} [${p.severity}, ${p.confidence}]: ${p.title} — evidence ${p.evidence.length}`);
  for (const s of result.steps) console.log(`  ${s.order}. (${s.where}) ${s.title}`);
  if (warnings.length) console.log(`warnings: ${warnings.join(" ")}`);
}

main().catch((error: Error) => {
  console.error(`${(error as { code?: string }).code ?? "error"}: ${error.message}`);
  process.exit(1);
});
