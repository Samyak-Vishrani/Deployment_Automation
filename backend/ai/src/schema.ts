/**
 * The JSON schema of an AnalysisResult, for OpenAI Structured Outputs
 * (`response_format: { type: "json_schema", json_schema: { strict: true } }`).
 *
 * Strict mode requires every property to be listed in `required` and
 * `additionalProperties: false` everywhere; optional values are nullable.
 */

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;

const evidence = {
  type: "object",
  additionalProperties: false,
  required: ["componentId", "source", "line", "deploymentId"],
  properties: { componentId: nullableStr, source: str, line: str, deploymentId: nullableStr },
} as const;

const problem = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "severity", "category", "componentIds", "rootCause", "confidence", "evidence"],
  properties: {
    id: str,
    title: str,
    severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    category: str,
    componentIds: { type: "array", items: str },
    rootCause: str,
    confidence: { type: "number" },
    evidence: { type: "array", items: evidence },
  },
} as const;

const step = {
  type: "object",
  additionalProperties: false,
  required: ["order", "title", "detail", "problemIds", "where", "componentId", "command", "file", "envKey"],
  properties: {
    order: { type: "integer" },
    title: str,
    detail: str,
    problemIds: { type: "array", items: str },
    where: { type: "string", enum: ["configure", "settings", "environment", "repository", "provider_dashboard", "redeploy"] },
    componentId: nullableStr,
    command: nullableStr,
    file: nullableStr,
    envKey: nullableStr,
  },
} as const;

export const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "problems", "steps", "components", "providerNotes", "followUps"],
  properties: {
    verdict: { type: "string", enum: ["healthy", "degraded", "failing", "unknown"] },
    summary: str,
    problems: { type: "array", items: problem },
    steps: { type: "array", items: step },
    components: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["componentId", "status", "note"],
        properties: {
          componentId: str,
          status: { type: "string", enum: ["ok", "warning", "failing", "unknown"] },
          note: str,
        },
      },
    },
    providerNotes: nullableStr,
    followUps: { type: "array", items: str },
  },
} as const;
