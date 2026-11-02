import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";

// The sample endpoint was replaced by authenticated, owned deployment analysis.
// Run after signing in; supply the session cookie through an environment variable.
const session = process.env.ORBITOPS_SESSION_COOKIE;
if (!session) {
  console.error("Use Analyze failure with AI in the deployment panel, or set ORBITOPS_SESSION_COOKIE for this CLI.");
  process.exitCode = 1;
} else {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const projectId = await rl.question("Project ID: ");
    const deploymentId = await rl.question("Failed Render deployment ID: ");
    const response = await fetch(`${process.env.ORBITOPS_API_URL ?? 'http://localhost:3001'}/api/log-analysis/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: process.env.FRONTEND_URL ?? "http://localhost:3000", Cookie: `orbitops_session=${session}` },
      body: JSON.stringify({ projectId: projectId.trim(), deploymentId: deploymentId.trim() }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Analysis failed.");
    console.log(JSON.stringify(result.analysis, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Analysis failed.");
    process.exitCode = 1;
  } finally { rl.close(); }
}
