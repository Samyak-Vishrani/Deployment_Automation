import { AnalysisService } from "@/lib/analysis/analysis.service";
import { ComponentsService } from "@/lib/components/components.service";
import prisma from "@/lib/db/prisma";
import { DeployExecutor } from "@/lib/deployments/deploy-executor.service";
import { DeploymentLogsService } from "@/lib/deployments/deployment-logs.service";
import { DeploymentQueue } from "@/lib/deployments/deployment-queue";
import { DeploymentsService } from "@/lib/deployments/deployments.service";
import { DockerService } from "@/lib/docker/docker.service";
import { EventsService } from "@/lib/events/events.service";
import { GithubAppService } from "@/lib/github/github-app.service";
import { GithubUserService } from "@/lib/github/github-user.service";
import { ProjectsService } from "@/lib/projects/projects.service";
import { ProviderDeploymentsService } from "@/lib/providers/provider-deployments.service";
import { ProviderLogSink } from "@/lib/providers/provider-log-sink";
import { VercelServiceClient } from "@/lib/providers/vercel-service.client";
import { DeliveryStore } from "@/lib/webhooks/delivery-store";

/**
 * The process-wide service graph, and the startup work NestJS used to do in
 * onApplicationBootstrap / onApplicationShutdown.
 *
 * Every one of these holds state that must survive across requests: the queue's
 * in-flight jobs, the GitHub token cache, the log event bus, the delivery
 * dedupe window. A Next.js route module is re-evaluated on hot reload, so they
 * are parked on globalThis - the same reason lib/db/prisma.ts does it. Without
 * that, editing a file mid-build would hand the next request a fresh, empty
 * queue while the old one was still running the job.
 */
export interface Runtime {
  events: EventsService;
  github: GithubAppService;
  githubUser: GithubUserService;
  docker: DockerService;
  queue: DeploymentQueue;
  logs: DeploymentLogsService;
  deployments: DeploymentsService;
  projects: ProjectsService;
  analysis: AnalysisService;
  components: ComponentsService;
  /** Client for the vercel_integration service (backend/vercel_integration). */
  vercel: VercelServiceClient;
  /** Deploys to external providers and applies the events they report back. */
  providerDeployments: ProviderDeploymentsService;
  deliveries: DeliveryStore;
  executor: DeployExecutor;
  bootstrapped?: Promise<void>;
}

const globalForRuntime = globalThis as unknown as { __orbitopsRuntime?: Runtime };

function build(): Runtime {
  const events = new EventsService();
  const github = new GithubAppService();
  const githubUser = new GithubUserService(prisma);
  const docker = new DockerService();
  const queue = new DeploymentQueue();
  const logs = new DeploymentLogsService();
  const deliveries = new DeliveryStore();

  const deployments = new DeploymentsService(prisma, queue, events);
  const projects = new ProjectsService(prisma, github, githubUser, docker, events);
  const analysis = new AnalysisService(prisma, github);
  const vercel = new VercelServiceClient();
  const providerDeployments = new ProviderDeploymentsService(
    prisma,
    github,
    events,
    vercel,
    new ProviderLogSink(logs),
  );
  const components = new ComponentsService(prisma, github, analysis, events, async (userId, provider) => {
    if (provider !== "vercel") return "missing";
    try {
      return (await vercel.getCredential(userId)).state;
    } catch {
      return "unavailable";
    }
  });
  const executor = new DeployExecutor(prisma, github, docker, logs, events);

  // The queue is constructed before the executor exists, so the runner is
  // attached here rather than in its constructor.
  queue.setRunner((job, signal) => executor.run(job, signal));

  return {
    events,
    github,
    githubUser,
    docker,
    queue,
    logs,
    deployments,
    projects,
    analysis,
    components,
    vercel,
    providerDeployments,
    deliveries,
    executor,
  };
}

export function services(): Runtime {
  if (!globalForRuntime.__orbitopsRuntime) {
    globalForRuntime.__orbitopsRuntime = build();
  }
  return globalForRuntime.__orbitopsRuntime;
}

/**
 * Startup reconciliation, run once per process and awaited by the routes that
 * depend on it.
 *
 * This is what buys back the durability an in-memory queue gives up. Jobs live
 * in Postgres as 'queued' rows before they are ever enqueued, so re-reading
 * them here restores the backlog across a restart or a crash - no Redis
 * required. It is lazy because Next.js has no server-start hook: the first
 * request that touches the deployment pipeline pays for it, once.
 */
export function ensureBootstrapped(): Promise<void> {
  const rt = services();
  if (!rt.bootstrapped) {
    rt.bootstrapped = bootstrap(rt).catch((error: Error) => {
      // Do not cache a rejected promise: a transient database outage at boot
      // would otherwise poison every later request for the life of the process.
      rt.bootstrapped = undefined;
      throw error;
    });
  }
  return rt.bootstrapped;
}

async function bootstrap(rt: Runtime): Promise<void> {
  // Anything left 'running' is a lie from a previous process: nothing is
  // executing it now, and without this it would sit there for ever.
  //
  // Local Docker builds only. A provider deploy (Vercel) runs in its
  // integration service, not in this process, so a restart here does not
  // interrupt it; reconcile() below checks those instead.
  const stale = await prisma.deployment.updateMany({
    where: { status: "running", provider: "local_docker" },
    data: {
      status: "failed",
      errorMessage: "Interrupted by a backend restart.",
      finishedAt: new Date(),
    },
  });
  if (stale.count > 0) {
    console.warn(`[bootstrap] Marked ${stale.count} interrupted deployment(s) as failed.`);
  }

  const pending = await prisma.deployment.findMany({
    where: { status: "queued", provider: "local_docker" },
    orderBy: { queuedAt: "asc" },
    select: { id: true, projectId: true },
  });
  for (const deployment of pending) {
    rt.queue.add({ deploymentId: deployment.id, projectId: deployment.projectId });
  }
  if (pending.length > 0) {
    console.log(`[bootstrap] Requeued ${pending.length} pending deployment(s).`);
  }

  // Containers whose project has been deleted have nothing left to manage
  // them, and they still hold a host port.
  const projects = await prisma.project.findMany({ select: { id: true } });
  await rt.docker.sweepOrphans(new Set(projects.map((p) => p.id)));

  registerShutdownHooks(rt);

  // Not awaited: a slow or stopped integration service must not hold up every
  // request that waits on bootstrap.
  void rt.providerDeployments
    .reconcile()
    .catch((error: Error) => console.warn(`[bootstrap] Provider reconcile failed: ${error.message}`));
}

const globalForHooks = globalThis as unknown as { __orbitopsShutdownHooked?: boolean };

/**
 * Drains the queue on Ctrl-C so a shutdown does not orphan an in-flight build:
 * a half-created container and a workspace left on disk.
 *
 * Guarded by its own global flag, because a hot reload rebuilds the runtime but
 * the process - and therefore the listeners already attached to it - persists.
 */
function registerShutdownHooks(rt: Runtime): void {
  if (globalForHooks.__orbitopsShutdownHooked) {
    return;
  }
  globalForHooks.__orbitopsShutdownHooked = true;

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal}; draining the deployment queue.`);
    const affected = await rt.queue.drain();
    if (affected.length > 0) {
      await prisma.deployment.updateMany({
        where: { id: { in: affected }, status: { in: ["queued", "running"] } },
        data: {
          status: "cancelled",
          errorMessage: "Cancelled by backend shutdown.",
          finishedAt: new Date(),
        },
      });
      console.log(`[shutdown] Cancelled ${affected.length} in-flight deployment(s).`);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).finally(() => process.exit(0));
    });
  }
}
