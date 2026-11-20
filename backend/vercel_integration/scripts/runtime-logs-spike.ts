/**
 * Step 0 of PLAN_PHASE_12: how Vercel's runtime-logs stream really answers.
 *
 *   VERCEL_TOKEN=... SPIKE_PROJECT_ID=prj_... SPIKE_DEPLOYMENT_ID=dpl_... [SPIKE_TEAM_ID=team_...] \
 *   SPIKE_SECONDS=60 npm run spike:runtime
 *
 * Opens GET /v1/projects/:projectId/deployments/:deploymentId/runtime-logs,
 * prints the content type, then every line for SPIKE_SECONDS (hit the site
 * meanwhile), and writes them, with the token removed, to
 * ../logs/src/providers/__fixtures__/vercel-runtime-live.ndjson.
 * Read-only: it creates nothing.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const token = process.env.VERCEL_TOKEN?.trim();
const projectId = process.env.SPIKE_PROJECT_ID?.trim();
const deploymentId = process.env.SPIKE_DEPLOYMENT_ID?.trim();
const teamId = process.env.SPIKE_TEAM_ID?.trim();
const seconds = Number(process.env.SPIKE_SECONDS ?? 60);
const base = (process.env.VERCEL_API_BASE?.trim() || "https://api.vercel.com").replace(/\/+$/, "");

if (!token || !projectId || !deploymentId) {
  console.error("Set VERCEL_TOKEN, SPIKE_PROJECT_ID and SPIKE_DEPLOYMENT_ID (optional SPIKE_TEAM_ID, SPIKE_SECONDS).");
  process.exit(1);
}

async function main() {
  const url = new URL(`${base}/v1/projects/${encodeURIComponent(projectId!)}/deployments/${encodeURIComponent(deploymentId!)}/runtime-logs`);
  if (teamId) url.searchParams.set("teamId", teamId);
  const abort = AbortSignal.timeout(seconds * 1000);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: abort });
  console.log("status", response.status, "content-type", response.headers.get("content-type"));
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const clean = line.split(token!).join("***TOKEN***");
        lines.push(clean);
        console.log(clean);
      }
    }
    console.log("the stream ended on its own");
  } catch (error) {
    console.log(abort.aborted ? `stopped after ${seconds}s` : `stream error: ${(error as Error).message}`);
  }
  const dir = join(process.cwd(), "..", "logs", "src", "providers", "__fixtures__");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "vercel-runtime-live.ndjson"), lines.join("\n") + "\n");
  console.log(`${lines.length} line(s) written to ${dir}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
