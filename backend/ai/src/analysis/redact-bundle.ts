import { redact } from "@orbitops/integration-common/redact";
import type { ContextBundle } from "../types";

/**
 * Patterns carried over from the Groq demo's normalizer
 * (backend/lib/log-analysis/xxx_log-normalizer.ts), on top of the shared
 * redact(): passwords in connection strings, password assignments, and the
 * value of secret-looking KEY=value pairs.
 */
const EXTRA: Array<[RegExp, string]> = [
  [/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:\s/@]+:)[^@\s]+(@)/gi, "$1***REDACTED***$2"],
  [/\b(password|passwd|pwd)\s*[:=]\s*["']?[^"'\s,;]+["']?/gi, "$1=***REDACTED***"],
  [/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|DATABASE_URL)[A-Z0-9_]*)\s*=\s*\S+/g, "$1=***REDACTED***"],
  [/\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/g, "***REDACTED***"],
];

export function redactText(text: string): string {
  let out = redact(text);
  for (const [pattern, replacement] of EXTRA) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Every string in the bundle, redacted once more before anything leaves for
 * OpenAI. The backend already redacted with the user's own secret values;
 * this catches shapes it could not know. Keys (env var names, ids) are left
 * alone: only values that look like secrets change.
 */
export function redactBundle(bundle: ContextBundle): ContextBundle {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(bundle) as ContextBundle;
}
