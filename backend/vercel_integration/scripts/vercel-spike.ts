/**
 * Step 0 of PLAN_PHASE_6: confirm how the real Vercel API answers, against
 * YOUR account, before trusting the provider's assumptions.
 *
 *   VERCEL_TOKEN=... SPIKE_REPO=owner/repo SPIKE_REPO_ID=123456 \
 *   SPIKE_BRANCH=main SPIKE_ROOT_DIR=frontend npm run spike
 *
 * It creates ONE throwaway project named "orbitops-spike-<random>", tries a
 * Git-linked create, a Git-source deploy, polls it, reads its build events,
 * and deletes the project at the end. Responses are written, with the token
 * removed, to src/vercel/__fixtures__/spike-*.json so the error codes the
 * provider pattern-matches (isGitAccessError) can be checked against reality.
 *
 * Optional: SPIKE_TEAM_ID to run in a team scope; SPIKE_KEEP=1 to keep the project.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const token = process.env.VERCEL_TOKEN?.trim();
const repo = process.env.SPIKE_REPO?.trim();
const repoId = Number(process.env.SPIKE_REPO_ID);
const branch = process.env.SPIKE_BRANCH?.trim() || "main";
const rootDir = process.env.SPIKE_ROOT_DIR?.trim() || null;
const teamId = process.env.SPIKE_TEAM_ID?.trim() || null;
const base = (process.env.VERCEL_API_BASE?.trim() || "https://api.vercel.com").replace(/\/+$/, "");
const fixtures = join(process.cwd(), "src", "vercel", "__fixtures__");

if (!token || !repo || !Number.isInteger(repoId)) {
  console.error("Set VERCEL_TOKEN, SPIKE_REPO (owner/repo) and SPIKE_REPO_ID (GitHub's numeric repo id).");
  console.error('Find the repo id with: curl -s https://api.github.com/repos/OWNER/REPO | grep \'"id"\' | head -1');
  process.exit(1);
}

const scrub = (text: string) => text.split(token).join("***TOKEN***");

async function call(label: string, method: string, path: string, body?: unknown) {
  const url = new URL(`${base}${path}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  const record = {
    label,
    request: { method, path, body },
    status: response.status,
    headers: Object.fromEntries([...response.headers].filter(([k]) => /ratelimit|retry-after/i.test(k))),
    body: parsed,
  };
  await writeFile(join(fixtures, `spike-${label}.json`), scrub(JSON.stringify(record, null, 2)));
  console.log(`${label.padEnd(28)} HTTP ${response.status}`);
  return record;
}

async function main() {
  await mkdir(fixtures, { recursive: true });
  const name = `orbitops-spike-${randomBytes(3).toString("hex")}`;

  await call("user", "GET", "/v2/user");
  await call("teams", "GET", "/v2/teams?limit=20");

  const create = await call("create-project-git", "POST", "/v11/projects", {
    name,
    framework: "nextjs",
    rootDirectory: rootDir,
    gitRepository: { type: "github", repo },
  });
  let projectId = (create.body as { id?: string })?.id;
  if (!projectId) {
    console.log("  → Git-linked create failed; that response is the 'no GitHub access' shape. Retrying unlinked.");
    const unlinked = await call("create-project-unlinked", "POST", "/v11/projects", { name, framework: "nextjs", rootDirectory: rootDir });
    projectId = (unlinked.body as { id?: string })?.id;
  }
  if (!projectId) throw new Error("Could not create a test project; see the fixtures.");

  await call("disable-git-deploys", "PATCH", `/v9/projects/${projectId}`, {
    gitProviderOptions: { createDeployments: "disabled" },
  });
  await call("set-node-version", "PATCH", `/v9/projects/${projectId}`, { nodeVersion: "20.x" });

  const branchInfo = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`).then((r) =>
    r.ok ? (r.json() as Promise<{ commit?: { sha?: string } }>) : null,
  );
  const sha = branchInfo?.commit?.sha;
  if (!sha) {
    console.log("  → Could not read the branch head from GitHub (private repo?). Set the repo public for the spike, or skip deploys.");
  } else {
    const deploy = await call("deploy-git-source", "POST", "/v13/deployments?skipAutoDetectionConfirmation=1", {
      name,
      project: projectId,
      target: "production",
      gitSource: { type: "github", repoId, ref: branch, sha },
    });
    const deploymentId = (deploy.body as { id?: string })?.id;
    if (deploymentId) {
      for (let i = 0; i < 60; i++) {
        const status = await call(`status-${String(i).padStart(2, "0")}`, "GET", `/v13/deployments/${deploymentId}`);
        const state = (status.body as { readyState?: string })?.readyState;
        if (state === "READY" || state === "ERROR" || state === "CANCELED") break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await call("events", "GET", `/v3/deployments/${deploymentId}/events?builds=1&direction=forward&limit=-1`);
      await call("cancel-finished", "PATCH", `/v12/deployments/${deploymentId}/cancel`);
    }
  }

  await call("upload-missing-files", "POST", "/v13/deployments?skipAutoDetectionConfirmation=1", {
    name,
    project: projectId,
    target: "production",
    files: [{ file: "index.html", sha: "0".repeat(40), size: 1 }],
  });

  for (const framework of ["vite", "create-react-app", "nuxtjs", "sveltekit-1", "astro", "angular", "vue"]) {
    await call(`framework-${framework}`, "PATCH", `/v9/projects/${projectId}`, { framework });
  }

  if (process.env.SPIKE_KEEP === "1") {
    console.log(`Kept project ${name} (${projectId}).`);
  } else {
    await call("delete-project", "DELETE", `/v9/projects/${projectId}`);
  }
  console.log(`\nFixtures written to ${fixtures}. Check them for anything sensitive before committing.`);
}

main().catch((error: Error) => {
  console.error(scrub(error.message));
  process.exit(1);
});
