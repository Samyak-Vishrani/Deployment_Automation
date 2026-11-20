
import type { NormalizedLog } from "./log-normalizer";

export type FailureType =
  | "MISSING_DEPENDENCY"
  | "TYPESCRIPT_ERROR"
  | "MISSING_ENV_VARIABLE"
  | "DOCKER_BUILD_ERROR"
  | "PORT_CONFLICT"
  | "DATABASE_CONNECTION_ERROR"
  | "BUILD_TIMEOUT"
  | "RUNTIME_ERROR"
  | "UNKNOWN";

export type FailureSeverity =
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export interface FailureClassification {
  failureType: FailureType;
  severity: FailureSeverity;
  matchedPattern: string | null;
  evidence: string[];
}

type FailureRule = {
  failureType: FailureType;
  severity: FailureSeverity;
  patterns: RegExp[];
  description: string;
};

const FAILURE_RULES: FailureRule[] = [
  {
    failureType: "MISSING_ENV_VARIABLE",
    severity: "HIGH",
    description: "Missing environment variable",
    patterns: [
      /\b[A-Z][A-Z0-9_]*\s+is not defined\b/i,
      /\bmissing (?:environment )?variable\b/i,
      /\b(?:environment variable|env var)\b.*\bnot (?:set|found|configured)\b/i,
    ],
  },
  {
    failureType: "MISSING_DEPENDENCY",
    severity: "HIGH",
    description: "Missing dependency",
    patterns: [
      /Module not found:\s*Can't resolve/i,
      /Cannot find module ['"][^'"]+['"]/i,
      /ERR_MODULE_NOT_FOUND/i,
      /MODULE_NOT_FOUND/i,
    ],
  },
  {
    failureType: "TYPESCRIPT_ERROR",
    severity: "HIGH",
    description: "TypeScript compilation error",
    patterns: [
      /\berror TS\d{4}\b/i,
      /\bType .+ is not assignable to type\b/i,
      /\bFound \d+ error[s]?\b/i,
    ],
  },
  {
    failureType: "DOCKER_BUILD_ERROR",
    severity: "HIGH",
    description: "Docker build failure",
    patterns: [
      /\bCOPY failed\b/i,
      /\bDocker build failed\b/i,
      /\bfailed to solve\b/i,
      /\bno such file or directory\b/i,
    ],
  },
  {
    failureType: "PORT_CONFLICT",
    severity: "MEDIUM",
    description: "Port conflict",
    patterns: [
      /\bEADDRINUSE\b/i,
      /\baddress already in use\b/i,
    ],
  },
  {
    failureType: "DATABASE_CONNECTION_ERROR",
    severity: "HIGH",
    description: "Database connection failure",
    patterns: [
      /\bECONNREFUSED\b.*(?:5432|3306|database|postgres)/i,
      /\bconnection refused\b.*(?:database|postgres|mysql)/i,
      /\bfailed to connect to (?:database|postgres|mysql)\b/i,
      /\bdatabase connection failed\b/i,
    ],
  },
  {
    failureType: "BUILD_TIMEOUT",
    severity: "HIGH",
    description: "Build timeout",
    patterns: [
      /\bexceeded timeout\b/i,
      /\bbuild process timed out\b/i,
      /\btimeout limit\b/i,
      /\bETIMEDOUT\b/i,
    ],
  },
  {
    failureType: "RUNTIME_ERROR",
    severity: "HIGH",
    description: "Runtime application error",
    patterns: [
      /\bTypeError\b/i,
      /\bReferenceError\b/i,
      /\bApplication crashed\b/i,
      /\bUnhandled exception\b/i,
      /\bprocess exited with code [1-9]\d*\b/i,
    ],
  },
];

export function classifyFailure(
  normalizedLog: NormalizedLog
): FailureClassification {
  const logLines = normalizedLog.logs
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  for (const rule of FAILURE_RULES) {
    for (const pattern of rule.patterns) {
      const matchingLines = logLines.filter((line) =>
        pattern.test(line)
      );

      if (matchingLines.length > 0) {
        return {
          failureType: rule.failureType,
          severity: rule.severity,
          matchedPattern: rule.description,
          evidence: matchingLines.slice(0, 5),
        };
      }
    }
  }

  return {
    failureType: "UNKNOWN",
    severity: "MEDIUM",
    matchedPattern: null,
    evidence: logLines
      .filter((line) => /\b(error|failed|failure|exception)\b/i.test(line))
      .slice(0, 5),
  };
}
