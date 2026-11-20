/**
 * Step 0 of PLAN_PHASE_8: confirm how the real Neon API answers, against YOUR
 * account, before trusting the provider's assumptions.
 *
 *   NEON_API_KEY=... npm run spike
 *
 * It creates ONE throwaway project named "orbitops-spike-<random>", waits for
 * its operations, asks for its pooled and direct connection strings, reads it,
 * deletes it, and reads it again (the 404 shape). Every response is written,
 * with the key and every password removed, to src/neon/__fixtures__/ so the
 * shapes the provider expects (org_id required or not, operation statuses,
 * the project-limit and locked error texts) can be checked against reality.
 *
 * Optional: SPIKE_ORG_ID (else the only organization, if there is exactly
 * one), SPIKE_REGION (default aws-us-west-2), SPIKE_PG (default 17),
 * SPIKE_KEEP=1 to keep the project.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const key = process.env.NEON_API_KEY?.trim();
const base = (process.env.NEON_API_BASE?.trim() || "https://console.neon.tech/api/v2").replace(/\/+$/, "");
const region = process.env.SPIKE_REGION?.trim() || "aws-us-west-2";
const pgVersion = Number(process.env.SPIKE_PG ?? 17);
const fixtures = join(process.cwd(), "src", "neon", "__fixtures__");

if (!key) {
  console.error("Set NEON_API_KEY (console.neon.tech → Account settings → API keys). Optional: SPIKE_ORG_ID, SPIKE_REGION.");
  process.exit(1);
}

/** Removes the key, every password in a Postgres URI, and password fields. */
const scrub = (text: string) =>
  text
    .split(key)
    .join("***KEY***")
    .replace(/(postgres(?:ql)?:\/\/[^:\s"]+:)[^@\s"]+@/gi, "$1***PASSWORD***@")
    .replace(/("password"\s*:\s*")[^"]*"/gi, '$1***PASSWORD***"');

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
  console.log(`${label.padEnd(32)} HTTP ${response.status}`);
  return record;
}

async function main() {
  await mkdir(fixtures, { recursive: true });

  await call("users-me", "GET", "/users/me");
  const orgs = await call("organizations", "GET", "/users/me/organizations");
  const orgList = ((orgs.body as { organizations?: Array<{ id: string }> } | null)?.organizations ?? []).map((o) => o.id);
  const orgId = process.env.SPIKE_ORG_ID?.trim() || (orgList.length === 1 ? orgList[0] : undefined);
  console.log(`organizations: ${orgList.length}; using ${orgId ?? "(none: key default)"}`);

  const name = `orbitops-spike-${randomBytes(3).toString("hex")}`;

  // Does Neon require org_id for this key? Only tried when an org is known.
  if (orgId) await call("create-without-org", "POST", "/projects", { project: { name: `${name}-noorg`, region_id: region, pg_version: pgVersion } })
    .then(async (r) => {
      const id = (r.body as { project?: { id?: string } } | null)?.project?.id;
      if (id) {
        await sleep(3000);
        await call("delete-without-org", "DELETE", `/projects/${id}`);
      }
    });

  const created = await call("create", "POST", "/projects", {
    project: { name, region_id: region, pg_version: pgVersion, ...(orgId ? { org_id: orgId } : {}) },
  });
  const body = created.body as {
    project?: { id?: string };
    branch?: { id?: string };
    databases?: Array<{ name?: string; owner_name?: string }>;
  } | null;
  const projectId = body?.project?.id;
  if (!projectId) throw new Error("Create did not return a project id; see spike-create.json.");

  // A second operation-heavy call straight away, to see the 423 text if Neon locks.
  await call("locked-probe", "PATCH", `/projects/${projectId}`, { project: { name: `${name}-renamed` } });

  for (let i = 1; i <= 30; i++) {
    const ops = await call(`operations-${i}`, "GET", `/projects/${projectId}/operations?limit=50`);
    const list = (ops.body as { operations?: Array<{ status?: string }> } | null)?.operations ?? [];
    console.log(`  statuses: ${list.map((o) => o.status).join(", ")}`);
    if (list.every((o) => !["scheduling", "running", "cancelling"].includes(String(o.status)))) break;
    await sleep(1000);
  }

  const query = new URLSearchParams({
    branch_id: body?.branch?.id ?? "",
    database_name: body?.databases?.[0]?.name ?? "neondb",
    role_name: body?.databases?.[0]?.owner_name ?? "neondb_owner",
  });
  await call("connection-pooled", "GET", `/projects/${projectId}/connection_uri?${query}&pooled=true`);
  await call("connection-direct", "GET", `/projects/${projectId}/connection_uri?${query}&pooled=false`);
  await call("project", "GET", `/projects/${projectId}`);

  if (process.env.SPIKE_KEEP === "1") {
    console.log(`Kept ${projectId}. Delete it on the console when done.`);
    return;
  }
  await call("delete", "DELETE", `/projects/${projectId}`);
  await call("project-after-delete", "GET", `/projects/${projectId}`);
  console.log(`Done. Fixtures in ${fixtures}`);
}

main().catch((error: Error) => {
  console.error(scrub(error.message));
  process.exit(1);
});
