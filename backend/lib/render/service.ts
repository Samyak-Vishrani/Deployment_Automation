import { randomUUID, createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/prisma";
import { badRequest, conflict, HttpError, notFound } from "@/lib/api/http-error";
import { open, seal } from "@/lib/crypto/secret-box";
import { analyzeDeploymentLogs } from "@/lib/log-analysis/log-analysis.service";
import { ACTIVE, RenderClient, RenderError, deploymentStatus, safeServiceUrl, type RenderDeploy, type RenderLog, type RenderService } from "./client";
import { parseEnvironment, scrubLogs, textField } from "./security";
import { lockUser } from "./lock";

async function connection(userId: string) {
  const row = await prisma.renderConnection.findUnique({ where: { userId } });
  if (!row) throw badRequest("Connect your Render account first.");
  return { ...row, token: open(row.tokenEnc) };
}

async function componentFor(userId: string, projectId: string, componentId: string) {
  const row = await prisma.component.findFirst({ where: { id: componentId, projectId, project: { userId } }, include: { project: true, renderConfig: true } });
  if (!row) throw notFound("Backend component not found.");
  if (row.kind !== "backend" || row.provider !== "render") throw badRequest("Choose a backend component with Render as its provider.");
  return row;
}

async function ownedRun(userId: string, projectId: string, id: string) {
  const run = await prisma.renderDeployment.findFirst({ where: { id, config: { component: { projectId, project: { userId } } } }, include: { config: { include: { component: { include: { project: true } } } } } });
  if (!run) throw notFound("Deployment not found.");
  return run;
}

export async function connectionView(userId: string) {
  const row = await prisma.renderConnection.findUnique({ where: { userId }, select: { ownerId: true, ownerName: true } });
  return { connected: Boolean(row), ...row };
}

export async function connect(userId: string, body: Record<string, unknown>) {
  if (!process.env.ENCRYPTION_KEY) throw new HttpError("Set ENCRYPTION_KEY on the server before connecting Render.", 503);
  const token = textField(body, "apiKey", 512);
  const client = new RenderClient(token);
  const owners = await client.owners();
  if (body.action === "workspaces") return { owners };
  const ownerId = textField(body, "ownerId");
  const owner = owners.find(item => item.id === ownerId);
  if (!owner) throw badRequest("This API key cannot access the selected workspace.");
  const tokenEnc = seal(token);
  await prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    const existing = await tx.renderConfig.count({ where: { component: { project: { userId } }, ownerId: { not: ownerId } } });
    if (existing) throw conflict("Existing Render configurations belong to another workspace. Keep that workspace connected.");
    await tx.renderConnection.upsert({ where: { userId }, create: { userId, tokenEnc, ownerId, ownerName: owner.name }, update: { tokenEnc, ownerId, ownerName: owner.name } });
  });
  return connectionView(userId);
}

export async function disconnect(userId: string) {
  await prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    if (await tx.renderDeployment.count({ where: { status: { in: ACTIVE }, config: { component: { project: { userId } } } } })) throw conflict("Wait for active deployments to finish before disconnecting Render.");
    await tx.renderConnection.deleteMany({ where: { userId } });
  });
  return { connected: false };
}

export async function projectView(userId: string, projectId: string) {
  if (!await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } })) throw notFound("Project not found.");
  const components = await prisma.component.findMany({ where: { projectId, kind: "backend", provider: "render" }, include: { renderConfig: true }, orderBy: { createdAt: "asc" } });
  const [recent, active] = await Promise.all([
    prisma.renderDeployment.findMany({ where: { config: { component: { projectId } } }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.renderDeployment.findMany({ where: { config: { component: { projectId } }, status: { in: ACTIVE } } }),
  ]);
  const runs = [...new Map([...recent, ...active].map(run => [run.id, run])).values()].sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime());
  return {
    connection: await connectionView(userId), aiAvailable: Boolean(process.env.GROQ_API_KEY),
    components: components.map(({ renderConfig: c, ...component }) => ({ ...component,
      config: c ? { runtime: c.runtime, region: c.region, plan: c.plan, healthCheckPath: c.healthCheckPath, serviceId: c.serviceId, url: c.url, envKeys: Object.keys(JSON.parse(open(c.envEnc))) } : null,
    })),
    deployments: runs.map(runView),
  };
}

function runView(run: { id: string; componentId: string; status: string; error: string | null; logs: string; logWarning: string | null; analysis: Prisma.JsonValue; analysisError: string | null; createdAt: Date; finishedAt: Date | null }) {
  return { id: run.id, componentId: run.componentId, status: run.status, error: run.error, logs: run.logs,
    logWarning: run.logWarning, analysis: run.analysis, analysisError: run.analysisError, createdAt: run.createdAt, finishedAt: run.finishedAt };
}

export async function saveConfig(userId: string, projectId: string, body: Record<string, unknown>) {
  const componentId = textField(body, "componentId");
  await componentFor(userId, projectId, componentId);
  const runtime = textField(body, "runtime");
  const region = textField(body, "region");
  const plan = textField(body, "plan");
  if (!["node", "python", "go", "ruby", "rust"].includes(runtime)) throw badRequest("Unsupported Render runtime.");
  if (!["singapore", "oregon", "ohio", "virginia", "frankfurt"].includes(region)) throw badRequest("Invalid region.");
  if (!["free", "starter", "standard"].includes(plan)) throw badRequest("Invalid plan.");
  const healthCheckPath = typeof body.healthCheckPath === "string" ? body.healthCheckPath : "";
  if (healthCheckPath && (!/^\/[A-Za-z0-9/_\-.]*$/.test(healthCheckPath) || healthCheckPath.length > 200)) throw badRequest("Health check must be a URL path such as /health.");
  const env = body.envVars === undefined ? undefined : parseEnvironment(body.envVars);
  await prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    const account = await tx.renderConnection.findUnique({ where: { userId } });
    if (!account) throw badRequest("Connect Render first.");
    const existing = await tx.renderConfig.findUnique({ where: { componentId } });
    if (await tx.renderDeployment.count({ where: { componentId, status: { in: ACTIVE } } })) throw conflict("Wait for the deployment to finish before editing settings.");
    if (existing?.serviceId && (runtime !== existing.runtime || region !== existing.region || plan !== existing.plan)) throw conflict("Runtime, region and plan are fixed after creation. Manage infrastructure changes in Render.");
    const envEnc = env ? seal(JSON.stringify(env)) : existing?.envEnc ?? seal("{}");
    const data = { runtime, region, plan, healthCheckPath, envEnc };
    await tx.renderConfig.upsert({ where: { componentId }, create: { componentId, ownerId: account.ownerId, serviceName: `orbitops-${createHash("sha256").update(componentId).digest("hex").slice(0, 24)}`, ...data }, update: data });
  });
  return projectView(userId, projectId);
}

/** Persist intent before any provider write. One active request per component, enforced in Postgres. */
export async function deploy(userId: string, projectId: string, body: Record<string, unknown>) {
  const componentId = textField(body, "componentId");
  const requestKey = textField(body, "requestKey", 80);
  if (!/^[A-Za-z0-9-]{16,80}$/.test(requestKey)) throw badRequest("Invalid deployment request key.");
  const component = await componentFor(userId, projectId, componentId);
  const config = component.renderConfig;
  if (!config) throw badRequest("Save Render settings first.");
  if (!component.startCmd) throw badRequest("Set the backend start command in Configure components first.");
  const fullName = component.project.repoFullName ?? component.project.githubFullName;
  const branch = component.project.branch ?? component.project.defaultBranch;
  if (!fullName || !/^[\w.-]+\/[\w.-]+$/.test(fullName) || !branch) throw badRequest("Connect a GitHub repository and branch first.");
  const account = await connection(userId);
  if (account.ownerId !== config.ownerId) throw conflict("Reconnect the workspace used by this service.");
  const env = JSON.parse(open(config.envEnc)) as Record<string, string>;
  // Lazy import keeps the existing service graph independent of this provider.
  const { services } = await import("@/lib/runtime");
  const [owner, repo] = fullName.split("/");
  if (!await services().githubUser.canAccess(userId, { owner, repo, fullName })) throw new HttpError("Reconnect GitHub and grant access to this repository.", 403);
  const preflight = await services().components.preflight(userId, projectId, componentId, [...Object.keys(env).filter(key => env[key].trim()), "PORT", ...(component.nodeVersion ? ["NODE_VERSION"] : [])]);
  if (!preflight.ok) throw badRequest(preflight.checks.filter(c => c.status !== "pass").map(c => c.message).join(" "));

  const intent = await prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    const prior = await tx.renderDeployment.findUnique({ where: { requestKey } });
    if (prior) {
      if (prior.componentId !== componentId) throw conflict("Request key already used.");
      return { row: prior, created: false };
    }
    if (await tx.renderDeployment.count({ where: { componentId, status: { in: ACTIVE } } })) throw conflict("A deployment is already active. Refresh its status.");
    const latest = await tx.renderConfig.findUniqueOrThrow({ where: { componentId } });
    const currentComponent = await tx.component.findUniqueOrThrow({ where: { id: componentId } });
    const currentAccount = await tx.renderConnection.findUnique({ where: { userId } });
    if (latest.updatedAt.getTime() !== config.updatedAt.getTime() || currentComponent.updatedAt.getTime() !== component.updatedAt.getTime() || currentAccount?.updatedAt.getTime() !== account.updatedAt.getTime()) throw conflict("Settings changed. Refresh and deploy again.");
    const row = await tx.renderDeployment.create({ data: { componentId, requestKey, secretSnapshotEnc: seal(JSON.stringify([account.token, ...Object.values(env)])), syncAfter: new Date(Date.now() + 90_000) } });
    await tx.component.update({ where: { id: componentId }, data: { status: "deploying" } });
    return { row, created: true };
  });
  if (!intent.created) return runView(intent.row);
  const client = new RenderClient(account.token);
  const buildCommand = [component.installCmd, component.buildCmd].filter(Boolean).join(" && ") || "true";
  const envVars = Object.entries({ ...env, ...(component.nodeVersion && config.runtime === "node" ? { NODE_VERSION: component.nodeVersion } : {}) }).map(([key, value]) => ({ key, value }));
  let phase = "configure";
  try {
    let deployId: string;
    if (!config.serviceId) {
      phase = "create";
      await prisma.renderDeployment.update({ where: { id: intent.row.id }, data: { phase } });
      const created = await client.request<{ service: RenderService; deployId: string }>("/services", "POST", {
        type: "web_service", name: config.serviceName, ownerId: config.ownerId,
        repo: `https://github.com/${fullName}`, branch, rootDir: component.rootDir === "." ? "" : component.rootDir,
        autoDeployTrigger: "off", envVars,
        serviceDetails: { runtime: config.runtime, region: config.region, plan: config.plan,
          healthCheckPath: config.healthCheckPath, envSpecificDetails: { buildCommand, startCommand: component.startCmd } },
      });
      if (!created.service?.id || !created.deployId) throw new RenderError("Render did not return deployment identifiers. Refresh status.", true);
      deployId = created.deployId;
      await prisma.renderConfig.update({ where: { componentId }, data: { serviceId: created.service.id, url: safeServiceUrl(created.service.serviceDetails?.url) } });
      await prisma.component.update({ where: { id: componentId }, data: { providerResourceId: created.service.id } });
    } else {
      const service = await client.request<RenderService>(`/services/${encodeURIComponent(config.serviceId)}`);
      if (service.ownerId !== config.ownerId) throw conflict("The service no longer belongs to the connected workspace.");
      await client.request(`/services/${config.serviceId}`, "PATCH", {
        branch, rootDir: component.rootDir === "." ? "" : component.rootDir, autoDeployTrigger: "off",
        serviceDetails: { healthCheckPath: config.healthCheckPath, envSpecificDetails: { buildCommand, startCommand: component.startCmd } },
      });
      await client.request(`/services/${config.serviceId}/env-vars`, "PUT", envVars);
      phase = "trigger";
      await prisma.renderDeployment.update({ where: { id: intent.row.id }, data: { phase } });
      const result = await client.request<RenderDeploy>(`/services/${config.serviceId}/deploys`, "POST", {});
      if (!result.id) throw new RenderError("Render did not return a deployment ID. Refresh status.", true);
      deployId = result.id;
    }
    return runView(await prisma.renderDeployment.update({ where: { id: intent.row.id }, data: { deployId, status: "deploying", phase: "monitor", syncAfter: new Date() } }));
  } catch (error) {
    // A process/DB/network failure after sending a creation must never lead to blind POST retries.
    const uncertain = phase !== "configure" && (!(error instanceof HttpError) || error instanceof RenderError && error.uncertain);
    const message = error instanceof HttpError ? error.message : "Deployment response could not be saved. Refresh status to reconcile with Render.";
    const row = await prisma.renderDeployment.update({ where: { id: intent.row.id }, data: { status: uncertain ? "uncertain" : "failed", error: message, finishedAt: uncertain ? null : new Date(), syncAfter: new Date() } });
    if (!uncertain) await prisma.component.update({ where: { id: componentId }, data: { status: "failed" } });
    return runView(row);
  }
}

/** Render continues running without this app. A refresh reconciles durable state after any restart. */
export async function sync(userId: string, projectId: string, id: string) {
  const run = await ownedRun(userId, projectId, id);
  if (!run.deployId && !ACTIVE.includes(run.status)) return runView(run);
  const account = await connection(userId);
  if (account.ownerId !== run.config.ownerId) throw conflict("Connect this deployment's Render workspace.");
  const lease = await prisma.renderDeployment.updateMany({ where: { id, syncAfter: { lte: new Date() } }, data: { syncAfter: new Date(Date.now() + 90_000) } });
  if (!lease.count) return runView(run);
  const client = new RenderClient(account.token);
  let serviceId = run.config.serviceId;
  let deployId = run.deployId;
  try {
    if (!deployId) {
      if (run.phase === "configure") {
        const row = await prisma.renderDeployment.update({ where: { id }, data: { status: "failed", error: "Interrupted before deployment was submitted. You can deploy again.", finishedAt: new Date() } });
        await prisma.component.update({ where: { id: run.componentId }, data: { status: "failed" } });
        return runView(row);
      }
      if (!serviceId) {
        const matches = await client.request<{ service: RenderService }[]>(`/services?ownerId=${encodeURIComponent(account.ownerId)}&name=${encodeURIComponent(run.config.serviceName)}&limit=100`);
        const service = matches.find(row => row.service.name === run.config.serviceName && row.service.ownerId === account.ownerId)?.service;
        if (service) {
          serviceId = service.id;
          await prisma.renderConfig.update({ where: { componentId: run.componentId }, data: { serviceId, url: safeServiceUrl(service.serviceDetails?.url) } });
          await prisma.component.update({ where: { id: run.componentId }, data: { providerResourceId: serviceId } });
        }
      }
      if (serviceId) {
        const matches = await client.request<{ deploy: RenderDeploy }[]>(`/services/${serviceId}/deploys?limit=100`);
        const candidates = matches.filter(row => new Date(row.deploy.createdAt).getTime() >= run.createdAt.getTime() - 5000);
        if (candidates.length === 1) deployId = candidates[0].deploy.id;
      }
      if (!deployId) {
        return runView(await prisma.renderDeployment.update({ where: { id }, data: { status: "uncertain", error: "Render has not confirmed a unique deployment. Check its dashboard and refresh. Automatic retries are blocked to prevent duplicates." } }));
      }
    }
    if (!serviceId) throw new RenderError("Deployment has no associated Render service.");
    const remote = await client.request<RenderDeploy>(`/services/${serviceId}/deploys/${deployId}`);
    const status = deploymentStatus(remote.status);
    let logs = run.logs;
    let logWarning: string | null = null;
    try {
      // A bounded tail by service and deployment time. Render logs do not expose a deployId filter.
      const query = new URLSearchParams({ ownerId: account.ownerId, resource: serviceId, startTime: run.createdAt.toISOString(),
        endTime: remote.finishedAt ?? new Date().toISOString(), direction: "backward", limit: "1000" });
      query.append("type", "build"); query.append("type", "app");
      const result = await client.request<{ logs: RenderLog[]; hasMore: boolean }>(`/logs?${query}`);
      const secrets = JSON.parse(open(run.secretSnapshotEnc)) as string[];
      const lines = result.logs.slice().sort((a,b) => a.timestamp.localeCompare(b.timestamp)).map(line => `${line.timestamp} ${line.message}`).join("\n");
      if (lines) logs = scrubLogs(lines, [account.token, ...secrets]);
      if (result.hasMore || lines.length > 60_000) logWarning = "Showing the latest log tail. Open Render for the full logs.";
    } catch {
      logWarning = "Logs are temporarily unavailable from Render. Status is still updated; refresh to retry or open Render.";
    }
    const service = await client.request<RenderService>(`/services/${serviceId}`);
    const url = safeServiceUrl(service.serviceDetails?.url);
    const row = await prisma.$transaction(async tx => {
      const updated = await tx.renderDeployment.update({ where: { id }, data: { deployId, status, phase: remote.status, logs, logWarning,
        error: status === "failed" ? `Render reported ${remote.status.replaceAll("_", " ")}. Review the logs or run AI analysis.` : null,
        finishedAt: ACTIVE.includes(status) ? null : new Date(remote.finishedAt ?? Date.now()) } });
      // Old history refreshes must not overwrite a newer deployment's component state.
      const latest = await tx.renderDeployment.findFirst({ where: { componentId: run.componentId }, orderBy: { createdAt: "desc" } });
      if (latest?.id === id) {
        await tx.component.update({ where: { id: run.componentId }, data: { status: status === "live" ? "live" : status === "deploying" ? "deploying" : "failed", ...(status === "live" ? { url } : {}) } });
      }
      await tx.renderConfig.update({ where: { componentId: run.componentId }, data: { url } });
      return updated;
    });
    return runView(row);
  } finally {
    await prisma.renderDeployment.update({ where: { id }, data: { syncAfter: new Date(Date.now() + 12_000) } });
  }
}

export async function analyze(userId: string, projectId: string, id: string) {
  const run = await ownedRun(userId, projectId, id);
  if (run.analysis) return run.analysis;
  if (!process.env.GROQ_API_KEY) throw new HttpError("AI analysis is not configured. Set GROQ_API_KEY on the server.", 503);
  if (run.status !== "failed") throw badRequest("AI failure analysis is available after a deployment fails.");
  if (!run.logs.trim()) throw badRequest("No deployment logs are available yet. Refresh logs first.");
  const lease = await prisma.renderDeployment.updateMany({ where: { id, analysis: { equals: Prisma.DbNull }, OR: [{ analysisStartedAt: null }, { analysisStartedAt: { lt: new Date(Date.now() - 120_000) } }] }, data: { analysisStartedAt: new Date(), analysisError: null } });
  if (!lease.count) throw conflict("Analysis is running or was just attempted. Wait two minutes before retrying.");
  try {
    const result = await analyzeDeploymentLogs({ source: "deployment", logType: "deployment", projectName: run.config.component.project.name, deploymentId: id, logs: run.logs.slice(-24_000) });
    const secrets = JSON.parse(open(run.secretSnapshotEnc)) as string[];
    // Scrub string leaves without truncating serialized JSON or damaging its schema.
    const clean = (value: unknown): unknown => typeof value === "string" ? scrubLogs(value, secrets) : Array.isArray(value) ? value.map(clean) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, val]) => [key, clean(val)])) : value;
    const analysis = clean(result) as Prisma.InputJsonValue;
    await prisma.renderDeployment.update({ where: { id }, data: { analysis, analysisError: null } });
    return analysis;
  } catch {
    await prisma.renderDeployment.update({ where: { id }, data: { analysisError: "AI analysis is temporarily unavailable. Your deployment and logs are unaffected. Retry in two minutes." } });
    throw new HttpError("AI analysis failed. Retry in two minutes or inspect the deployment logs.", 502, "analysis_failed");
  }
}

/** Explicit user acknowledgement is required to abandon an unconfirmed request. Never auto-retry it. */
export async function acknowledgeUncertain(userId: string, projectId: string, id: string) {
  const run = await ownedRun(userId, projectId, id);
  const updated = await prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    const result = await tx.renderDeployment.updateMany({ where: { id, status: "uncertain", syncAfter: { lte: new Date() }, createdAt: { lt: new Date(Date.now() - 5 * 60_000) } }, data: { status: "cancelled", finishedAt: new Date(), error: "User acknowledged the unconfirmed request after checking Render. This does not cancel anything in Render." } });
    if (result.count) await tx.component.update({ where: { id: run.componentId }, data: { status: "configured" } });
    return result;
  });
  if (!updated.count) throw conflict("Only an unconfirmed request older than five minutes can be acknowledged.");
  return { acknowledged: true, requestKey: randomUUID() };
}
