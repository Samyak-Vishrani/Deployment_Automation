import type { ProjectAnalysis } from "./types";

/**
 * Prints one analysis result to the browser console, for checking the Phase 4
 * output by eye: what was detected, from which evidence, and what was skipped.
 *
 * Debug aid only. Nothing reads its output, so it is safe to delete.
 */
export function logAnalysis(label: string, analysis: ProjectAnalysis, startedAt?: number): void {
  const took = startedAt === undefined ? "" : ` in ${Math.round(performance.now() - startedAt)}ms`;

  if (!analysis.analysisId) {
    console.log(`[analysis] ${label}${took}: ${analysis.repository} has not been analysed yet`);
    return;
  }

  console.group(
    `[analysis] ${label}${took}: ${analysis.repository}@${analysis.branch} ` +
      `${analysis.commitSha?.slice(0, 7)} · ${analysis.components.length} component(s)`,
  );
  console.log("snapshot", {
    analysisId: analysis.analysisId,
    commitSha: analysis.commitSha,
    source: analysis.source,
    reused: analysis.reused,
    analyzedAt: analysis.analyzedAt,
  });
  console.table(
    analysis.components.map((component) => ({
      path: component.path,
      role: component.role,
      framework: component.framework,
      version: component.detectedVersion,
      packageManager: component.packageManager,
      runtime: component.runtimeVersion,
      install: component.installCmd,
      build: component.buildCmd,
      start: component.startCmd,
      output: component.outputDir,
      confidence: component.confidence,
    })),
  );
  for (const component of analysis.components) {
    console.log(`evidence for ${component.path}:`, component.evidence);
  }
  console.log("database hint", analysis.database);
  if (analysis.warnings.length > 0) {
    console.warn("warnings", analysis.warnings);
  } else {
    console.log("warnings: none");
  }
  console.groupEnd();
}
