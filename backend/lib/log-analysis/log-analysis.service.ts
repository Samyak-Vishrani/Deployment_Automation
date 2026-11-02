
import {
  normalizeLogs,
  type LogNormalizerInput,
} from "./log-normalizer";

import { classifyFailure } from "./failure-classifier";

import { analyzeLogsWithAI } from "./ai-agent.service";

export interface LogAnalysisServiceResult {
  metadata: {
    projectName: string;
    source: string;
    logType: string;
    deploymentId?: string;
    totalLines: number;
  };

  classification: {
    failureType: string;
    severity: string;
    matchedPattern: string | null;
    evidence: string[];
  };

  analysis: {
    failureType: string;
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    summary: string;
    rootCause: string;
    evidence: string[];
    recommendations: {
      title: string;
      description: string;
      command?: string;
      file?: string;
    }[];
    confidence: number;
  };
}

export async function analyzeDeploymentLogs(
  input: LogNormalizerInput
): Promise<LogAnalysisServiceResult> {
  // Step 1: Normalize and redact logs
  const normalizedLog = normalizeLogs(input);

  // Step 2: Detect probable failure category
  const classification = classifyFailure(normalizedLog);

  // Step 3: Analyze logs using Groq AI
  const aiAnalysis = await analyzeLogsWithAI(
    normalizedLog,
    classification
  );

  // Step 4: Return the complete analysis
  return {
    metadata: {
      projectName: normalizedLog.projectName,
      source: normalizedLog.source,
      logType: normalizedLog.logType,
      deploymentId: normalizedLog.deploymentId,
      totalLines: normalizedLog.totalLines,
    },

    classification: {
      failureType: classification.failureType,
      severity: classification.severity,
      matchedPattern: classification.matchedPattern,
      evidence: classification.evidence,
    },

    analysis: aiAnalysis,
  };
}
