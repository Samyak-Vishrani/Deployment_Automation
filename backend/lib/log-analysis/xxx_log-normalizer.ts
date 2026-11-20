
export type LogType = "build" | "runtime" | "deployment";

export type LogSource = "sample" | "manual" | "deployment";

export interface LogNormalizerInput {
  source: LogSource;
  logType: LogType;
  projectName: string;
  logs: string;
  deploymentId?: string;
}

export interface NormalizedLog {
  source: LogSource;
  logType: LogType;
  projectName: string;
  deploymentId?: string;
  logs: string;
  totalLines: number;
}

function redactSecrets(logs: string): string {
  let sanitizedLogs = logs;

  // Redact common API keys and access tokens
  sanitizedLogs = sanitizedLogs.replace(
    /\b(sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/g,
    "[REDACTED_TOKEN]"
  );

  // Redact password assignments
  sanitizedLogs = sanitizedLogs.replace(
    /(password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]+["']?/gi,
    "$1=[REDACTED]"
  );

  // Redact common database connection strings
  sanitizedLogs = sanitizedLogs.replace(
    /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi,
    "$1[REDACTED]$2"
  );

  // Redact environment variable values
  sanitizedLogs = sanitizedLogs.replace(
    /(DATABASE_URL|API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN)\s*=\s*.+/gi,
    "$1=[REDACTED]"
  );

  return sanitizedLogs;
}

function cleanLogs(logs: string): string {
  return logs
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function normalizeLogs(
  input: LogNormalizerInput
): NormalizedLog {
  const cleanedLogs = cleanLogs(input.logs);

  const sanitizedLogs = redactSecrets(cleanedLogs);

  return {
    source: input.source,
    logType: input.logType,
    projectName: input.projectName.trim(),
    deploymentId: input.deploymentId,
    logs: sanitizedLogs,
    totalLines: sanitizedLogs.split("\n").length,
  };
}
