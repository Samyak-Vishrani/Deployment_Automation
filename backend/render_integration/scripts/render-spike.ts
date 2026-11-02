/**
 * Step 0 of PLAN_PHASE_7: confirm how the real Render API answers, against
 * YOUR account, before trusting the provider's assumptions.
 *
 *   RENDER_API_KEY=... SPIKE_REPO=owner/repo SPIKE_BRANCH=main SPIKE_ROOT_DIR=backend npm run spike
 *
 * It creates ONE throwaway free web service named "orbitops-spike-<random>",
 * with auto-deploy off, deploys the branch head by commit, polls it, reads its
 * logs, tries the env var endpoints and a cancel, then deletes the service.
 * Responses are written, with the key removed, to src/render/__fixtures__/
 * so the shapes the provider expects (deployId on create, log labels, the
 * repo-access error text) can be checked against reality.
 *
 * Optional: SPIKE_OWNER_ID (else the first workspace), SPIKE_START (default
 * "npm start"), SPIKE_BUILD (default "npm install"), SPIKE_KEEP=1 to keep it.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const key = process.env.RENDER_API_KEY?.trim();
const repo = process.env.SPIKE_REPO?.trim();
const branch = process.env.SPIKE_BRANCH?.trim() || "main";
const rootDir = process.env.SPIKE_ROOT_DIR?.trim() || "";
const base = (process.env.RENDER_API_BASE?.trim() || "https://api.render.com/v1").replace(/\/+$/, "");
const fixtures = join(process.cwd(), "src", "render", "__fixtures__");

if (!key || !repo) {
  console.error("Set RENDER_API_KEY and SPIKE_REPO (owner/repo). Optional: SPIKE_BRANCH, SPIKE_ROOT_DIR, SPIKE_OWNER_ID.");
  process.exit(1);
}

const scrub = (text: string) => text.split(key).join("***KEY***");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(label: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: "error",
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
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
  console.log(`${label.padEnd(30)} HTTP ${response.status}`);
  return record;
}

async function main() {
  await mkdir(fixtures, { recursive: true });

  const owners = await call("owners", "GET", "/owners?limit=20");
  const rows = (owners.body as Array<{ owner?: { id?: string } }>) ?? [];
  const ownerId = process.env.SPIKE_OWNER_ID?.trim() || rows[0]?.owner?.id;
  if (!ownerId) throw new Error("No workspace visible to this key.");

  const branchInfo = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`).then((r) =>
    r.ok ? (r.json() as Promise<{ commit?: { sha?: string } }>) : null,
  );
  const sha = branchInfo?.commit?.sha;

  const name = `orbitops-spike-${randomBytes(3).toString("hex")}`;
  const created = await call("create-service", "POST", "/services", {
    type: "web_service",
    name,
    ownerId,
    repo: `https://github.com/${repo}`,
    branch,
    rootDir,
    autoDeployTrigger: "off",
    envVars: [{ key: "ORBITOPS_SPIKE", value: "1" }],
    serviceDetails: {
      runtime: "node",
      plan: "free",
      region: "oregon",
      numInstances: 1,
      healthCheckPath: "/health",
      envSpecificDetails: {
        buildCommand: process.env.SPIKE_BUILD?.trim() || "npm install",
        startCommand: process.env.SPIKE_START?.trim() || "npm start",
      },
    },
  });
  const body = created.body as { service?: { id?: string }; deployId?: string } | null;
  const serviceId = body?.service?.id;
  if (!serviceId) {
    console.log("  → Create failed. If it is about the repository, that response is the 'no GitHub access' shape.");
    return;
  }
  console.log(`  → initial deployId on create: ${body?.deployId ?? "(none)"}`);

  if (body?.deployId) {
    await call("initial-deploy", "GET", `/services/${serviceId}/deploys/${body.deployId}`);
    await call("cancel-initial", "POST", `/services/${serviceId}/deploys/${body.deployId}/cancel`);
  }

  await call("env-put", "PUT", `/services/${serviceId}/env-vars/ORBITOPS_SPIKE_2`, { value: "2" });
  await call("env-delete", "DELETE", `/services/${serviceId}/env-vars/ORBITOPS_SPIKE_2`);

  if (sha) {
    const deploy = await call("deploy-commit", "POST", `/services/${serviceId}/deploys`, { commitId: sha, clearCache: "do_not_clear" });
    const deployId = (deploy.body as { id?: string } | null)?.id;
    if (deployId) {
      for (let i = 0; i < 60; i++) {
        const status = await call(`status-${String(i).padStart(2, "0")}`, "GET", `/services/${serviceId}/deploys/${deployId}`);
        const state = (status.body as { status?: string } | null)?.status ?? "";
        if (["live", "build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"].includes(state)) break;
        await sleep(10_000);
      }
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await call(
        "logs",
        "GET",
        `/logs?ownerId=${ownerId}&resource=${serviceId}&type=build&type=app&direction=forward&limit=100&startTime=${encodeURIComponent(since)}`,
      );
      await call("service", "GET", `/services/${serviceId}`);
    }
  } else {
    console.log("  → Could not read the branch head from GitHub (private repo?); skipped the commit deploy.");
  }

  if (process.env.SPIKE_KEEP === "1") {
    console.log(`Kept service ${name} (${serviceId}).`);
  } else {
    await call("delete-service", "DELETE", `/services/${serviceId}`);
  }
  console.log(`\nFixtures written to ${fixtures}. Check them for anything sensitive before committing.`);
}

main().catch((error: Error) => {
  console.error(scrub(error.message));
  process.exit(1);
});
