import { api } from "@/lib/api";
import {
  PIPELINE_STAGE_NAMES,
  type AiInsight,
  type Deployment,
  type HealthCheck,
  type LogEntry,
  type PipelineRun,
  type PipelineStage,
  type PlatformProvider,
  type Project,
  type ProjectInput,
  type Session,
  type SimulationMode,
  type StageStatus,
} from "./types";

type MockStore = {
  projects: Project[];
  runs: PipelineRun[];
  deployments: Deployment[];
  logs: Record<string, LogEntry[]>;
  health: Record<string, HealthCheck[]>;
  insights: AiInsight[];
};

const STORAGE_KEY = "orbitops.mock.platform.v1";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ago(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function makeStages(status: StageStatus[], details?: string[]): PipelineStage[] {
  return PIPELINE_STAGE_NAMES.map((name, index) => ({
    id: name.toLowerCase().replaceAll(" ", "-"),
    name,
    status: status[index] ?? "pending",
    detail: details?.[index] ?? (status[index] === "succeeded" ? "Completed successfully" : "Waiting to start"),
    duration: status[index] === "succeeded" ? `${8 + index * 3}s` : undefined,
  }));
}

function seedStore(): MockStore {
  const projects: Project[] = [
    {
      id: "project-atlas",
      name: "Atlas API",
      slug: "atlas-api",
      description: "Core services for the Atlas workspace and developer portal.",
      repo: {
        provider: "github",
        owner: "orbitops-labs",
        name: "atlas-api",
        branch: "main",
        url: "https://github.com/orbitops-labs/atlas-api",
        connected: true,
        lastSyncAt: ago(11),
      },
      config: {
        environment: "development",
        port: 8080,
        healthPath: "/health",
        buildPreset: "node",
      },
      status: "healthy",
      createdAt: ago(9 * 24 * 60),
      latestRunId: "run-atlas-104",
      latestDeploymentId: "deployment-atlas-41",
    },
    {
      id: "project-signal",
      name: "Signal Dashboard",
      slug: "signal-dashboard",
      description: "A monitoring surface for release health and operational signals.",
      repo: {
        provider: "github",
        owner: "orbitops-labs",
        name: "signal-dashboard",
        branch: "main",
        url: "https://github.com/orbitops-labs/signal-dashboard",
        connected: true,
        lastSyncAt: ago(45),
      },
      config: {
        environment: "staging",
        port: 3000,
        healthPath: "/api/health",
        buildPreset: "nextjs",
      },
      status: "degraded",
      createdAt: ago(4 * 24 * 60),
      latestRunId: "run-signal-18",
      latestDeploymentId: "deployment-signal-09",
    },
  ];

  const runs: PipelineRun[] = [
    {
      id: "run-atlas-104",
      projectId: "project-atlas",
      number: 104,
      branch: "main",
      commitSha: "a84c1f2",
      commitMessage: "Add readiness check to the API container",
      triggeredBy: "Aarav Shah",
      triggerType: "push",
      status: "succeeded",
      startedAt: ago(18),
      finishedAt: ago(16),
      duration: "2m 14s",
      workflowUrl: "https://github.com/orbitops-labs/atlas-api/actions/runs/104",
      stages: makeStages(Array(6).fill("succeeded") as StageStatus[]),
      simulation: "success",
    },
    {
      id: "run-signal-18",
      projectId: "project-signal",
      number: 18,
      branch: "main",
      commitSha: "fd91b6e",
      commitMessage: "Tune dashboard data refresh interval",
      triggeredBy: "Aarav Shah",
      triggerType: "push",
      status: "failed",
      startedAt: ago(53),
      finishedAt: ago(50),
      duration: "3m 02s",
      workflowUrl: "https://github.com/orbitops-labs/signal-dashboard/actions/runs/18",
      stages: makeStages(
        ["succeeded", "succeeded", "succeeded", "failed", "skipped", "skipped"],
        [
          "Repository checked out",
          "Unit tests passed",
          "Image built locally",
          "Registry rejected the image push",
          "Deployment skipped",
          "Health check skipped",
        ],
      ),
      simulation: "failure",
      failureReason: "The container registry rejected the image push because the package permission is missing.",
    },
    {
      id: "run-atlas-103",
      projectId: "project-atlas",
      number: 103,
      branch: "main",
      commitSha: "1bca90d",
      commitMessage: "Move request tracing into the API middleware",
      triggeredBy: "Aarav Shah",
      triggerType: "manual",
      status: "succeeded",
      startedAt: ago(4 * 60),
      finishedAt: ago(4 * 60 - 3),
      duration: "2m 48s",
      workflowUrl: "https://github.com/orbitops-labs/atlas-api/actions/runs/103",
      stages: makeStages(Array(6).fill("succeeded") as StageStatus[]),
      simulation: "success",
    },
  ];

  const deployments: Deployment[] = [
    {
      id: "deployment-atlas-41",
      projectId: "project-atlas",
      runId: "run-atlas-104",
      version: "v104",
      environment: "development",
      status: "healthy",
      url: "https://atlas-api.dev.orbitops.local",
      image: "ghcr.io/orbitops-labs/atlas-api:a84c1f2",
      commitSha: "a84c1f2",
      createdAt: ago(16),
      finishedAt: ago(15),
      healthScore: 99,
      replicas: 3,
      readyReplicas: 3,
    },
    {
      id: "deployment-atlas-40",
      projectId: "project-atlas",
      runId: "run-atlas-103",
      version: "v103",
      environment: "development",
      status: "healthy",
      url: "https://atlas-api.dev.orbitops.local",
      image: "ghcr.io/orbitops-labs/atlas-api:1bca90d",
      commitSha: "1bca90d",
      createdAt: ago(4 * 60 - 3),
      finishedAt: ago(4 * 60 - 2),
      healthScore: 97,
      replicas: 3,
      readyReplicas: 3,
    },
    {
      id: "deployment-signal-09",
      projectId: "project-signal",
      runId: "run-signal-18",
      version: "v18",
      environment: "staging",
      status: "failed",
      url: "https://signal.staging.orbitops.local",
      image: "ghcr.io/orbitops-labs/signal-dashboard:fd91b6e",
      commitSha: "fd91b6e",
      createdAt: ago(50),
      finishedAt: ago(50),
      healthScore: 72,
      replicas: 2,
      readyReplicas: 1,
    },
  ];

  return {
    projects,
    runs,
    deployments,
    logs: {
      "run-atlas-104": [
        { id: "log-1", timestamp: ago(18), level: "info", source: "checkout", message: "Checked out orbitops-labs/atlas-api@a84c1f2" },
        { id: "log-2", timestamp: ago(17), level: "info", source: "test", message: "128 tests passed in 24.7s" },
        { id: "log-3", timestamp: ago(17), level: "info", source: "build", message: "Built image ghcr.io/orbitops-labs/atlas-api:a84c1f2" },
        { id: "log-4", timestamp: ago(16), level: "info", source: "deploy", message: "Deployment rolled out to 3 ready replicas" },
        { id: "log-5", timestamp: ago(15), level: "info", source: "health", message: "GET /health returned 200 in 18ms" },
      ],
      "run-signal-18": [
        { id: "log-6", timestamp: ago(53), level: "info", source: "checkout", message: "Checked out orbitops-labs/signal-dashboard@fd91b6e" },
        { id: "log-7", timestamp: ago(52), level: "info", source: "test", message: "64 tests passed in 18.4s" },
        { id: "log-8", timestamp: ago(51), level: "info", source: "build", message: "Built image ghcr.io/orbitops-labs/signal-dashboard:fd91b6e" },
        { id: "log-9", timestamp: ago(50), level: "error", source: "registry", message: "denied: requested access to the resource is denied" },
      ],
      "run-atlas-103": [
        { id: "log-10", timestamp: ago(4 * 60), level: "info", source: "checkout", message: "Checked out orbitops-labs/atlas-api@1bca90d" },
        { id: "log-11", timestamp: ago(4 * 60 - 1), level: "info", source: "build", message: "Container image built and pushed successfully" },
        { id: "log-12", timestamp: ago(4 * 60 - 2), level: "info", source: "deploy", message: "Kubernetes rollout completed" },
      ],
    },
    health: {
      "project-atlas": [
        { name: "API readiness", status: "passing", latencyMs: 18, detail: "All 3 replicas accept traffic" },
        { name: "Database connection", status: "passing", latencyMs: 42, detail: "Connection pool within normal range" },
        { name: "Error rate", status: "passing", latencyMs: 0, detail: "0.18% over the last 30 minutes" },
        { name: "Deployment rollout", status: "passing", latencyMs: 0, detail: "3 of 3 replicas ready" },
      ],
      "project-signal": [
        { name: "Dashboard readiness", status: "warning", latencyMs: 184, detail: "1 of 2 staging replicas ready" },
        { name: "API dependency", status: "passing", latencyMs: 67, detail: "Upstream API responding normally" },
        { name: "Error rate", status: "warning", latencyMs: 0, detail: "2.4% over the last 30 minutes" },
        { name: "Deployment rollout", status: "failing", latencyMs: 0, detail: "Image pull failed on one replica" },
      ],
    },
    insights: [
      {
        id: "insight-signal-18",
        projectId: "project-signal",
        runId: "run-signal-18",
        severity: "critical",
        title: "Registry permissions blocked the release",
        summary: "The build completed, but the registry rejected the push before Kubernetes received a new image.",
        probableCause: "The GitHub Actions package token does not have write access to the container package.",
        recommendedAction: "Grant the workflow packages:write permission and confirm the package visibility matches the repository policy.",
        confidence: 94,
        createdAt: ago(49),
        evidence: [
          "Build stage completed successfully",
          "Registry returned: requested access to the resource is denied",
          "Deploy and health stages did not start",
        ],
      },
      {
        id: "insight-atlas-104",
        projectId: "project-atlas",
        runId: "run-atlas-104",
        severity: "info",
        title: "Release completed with healthy rollout",
        summary: "The new readiness check passed across all replicas and the service is accepting traffic.",
        probableCause: "No active failure signal detected.",
        recommendedAction: "Continue monitoring the error rate after the release.",
        confidence: 98,
        createdAt: ago(14),
        evidence: ["All tests passed", "3 of 3 replicas ready", "Health endpoint returned 200"],
      },
    ],
  };
}

function formatDuration(startedAt: string) {
  const seconds = Math.max(1, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export class MockPlatformProvider implements PlatformProvider {
  private store: MockStore | null = null;

  private getStore() {
    if (this.store) {
      return this.store;
    }

    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        try {
          this.store = JSON.parse(stored) as MockStore;
        } catch {
          this.store = seedStore();
        }
      }
    }

    this.store ??= seedStore();
    return this.store;
  }

  private persist() {
    if (typeof window !== "undefined" && this.store) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.store));
    }
  }

  private syncRuns() {
    const store = this.getStore();
    let changed = false;

    for (const run of store.runs) {
      if (run.status !== "queued" && run.status !== "running") {
        continue;
      }

      const elapsed = Date.now() - Date.parse(run.startedAt);
      const previousStatus = run.status;
      const finished = elapsed >= 10_500;
      const activeStage = Math.min(5, Math.max(0, Math.floor(Math.max(0, elapsed - 1_500) / 1_500)));

      if (finished) {
        run.status = run.simulation === "failure" ? "failed" : "succeeded";
        run.finishedAt ??= new Date().toISOString();
        run.duration = formatDuration(run.startedAt);
        run.stages = makeStages(
          run.simulation === "failure"
            ? ["succeeded", "succeeded", "succeeded", "failed", "skipped", "skipped"]
            : Array(6).fill("succeeded") as StageStatus[],
          run.simulation === "failure"
            ? [
                "Repository checked out",
                "Unit tests passed",
                "Image built successfully",
                "Registry rejected the image push",
                "Deployment skipped",
                "Health check skipped",
              ]
            : undefined,
        );

        if (run.simulation === "success" && !store.deployments.some((deployment) => deployment.runId === run.id)) {
          const project = store.projects.find((item) => item.id === run.projectId);
          if (project) {
            const deployment: Deployment = {
              id: `deployment-${project.slug}-${Date.now()}`,
              projectId: project.id,
              runId: run.id,
              version: `v${run.number}`,
              environment: project.config.environment,
              status: "healthy",
              url: `https://${project.slug}.${project.config.environment}.orbitops.local`,
              image: `ghcr.io/${project.repo.owner}/${project.repo.name}:${run.commitSha}`,
              commitSha: run.commitSha,
              createdAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              healthScore: 99,
              replicas: 3,
              readyReplicas: 3,
            };
            store.deployments.unshift(deployment);
            project.latestDeploymentId = deployment.id;
            project.status = "healthy";
            store.health[project.id] = (store.health[project.id] ?? []).map((check) => ({
              ...check,
              status: "passing",
              detail: check.name === "Deployment rollout" ? `${deployment.replicas} of ${deployment.replicas} replicas ready` : check.detail === "Awaiting first release" ? "Signal is attached to the current release" : check.detail,
            }));
          }
        }
      } else if (elapsed < 1_500) {
        run.status = "queued";
        run.stages = makeStages(Array(6).fill("pending") as StageStatus[]);
      } else {
        run.status = "running";
        run.stages = makeStages(
          PIPELINE_STAGE_NAMES.map((_, index) => {
            if (index < activeStage) return "succeeded";
            if (index === activeStage) return "running";
            return "pending";
          }) as StageStatus[],
        );
      }

      changed ||= previousStatus !== run.status;
    }

    if (changed) {
      this.persist();
    }
    return store;
  }

  async login(email: string, password: string) {
    const body = await api.post<{ user?: Session["user"]; message?: string }>("/api/auth/login", {
      email,
      password,
    }).catch((error: unknown) => {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Unable to sign in.");
    });

    if (!body?.user) {
      throw new Error(body?.message ?? "Unable to sign in.");
    }
    return { user: body.user };
  }

  async logout() {
    await api.post<void>("/api/auth/logout");
  }

  async getSession() {
    try {
      return await api.get<Session>("/api/auth/me");
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as { status?: number }).status === 401) {
        return null;
      }
      throw error;
    }
  }

  async listProjects() {
    return clone(this.syncRuns().projects);
  }

  async createProject(input: ProjectInput) {
    const store = this.getStore();
    const parsed = new URL(input.repoUrl);
    const [owner, rawName] = parsed.pathname.split("/").filter(Boolean);
    const repoName = (rawName ?? "repository").replace(/\.git$/, "");
    const project: Project = {
      id: `project-${input.slug}-${Date.now()}`,
      name: input.name,
      slug: input.slug,
      description: input.description,
      repo: {
        provider: "github",
        owner: owner ?? "github-user",
        name: repoName,
        branch: input.branch,
        url: input.repoUrl,
        connected: true,
        lastSyncAt: new Date().toISOString(),
      },
      config: {
        environment: input.environment,
        port: input.port,
        healthPath: input.healthPath,
        buildPreset: input.buildPreset,
      },
      status: "offline",
      createdAt: new Date().toISOString(),
    };
    store.projects.unshift(project);
    store.health[project.id] = [
      { name: "Application readiness", status: "warning", latencyMs: 0, detail: "No deployment has run yet" },
      { name: "Database connection", status: "warning", latencyMs: 0, detail: "Not configured" },
      { name: "Error rate", status: "warning", latencyMs: 0, detail: "Awaiting first release" },
      { name: "Deployment rollout", status: "warning", latencyMs: 0, detail: "Awaiting first release" },
    ];
    this.persist();
    return clone(project);
  }

  async getProject(projectId: string) {
    const project = this.syncRuns().projects.find((item) => item.id === projectId);
    return project ? clone(project) : null;
  }

  async listPipelineRuns(projectId: string) {
    return clone(this.syncRuns().runs.filter((run) => run.projectId === projectId).sort((a, b) => b.number - a.number));
  }

  async getPipelineRun(runId: string) {
    const run = this.syncRuns().runs.find((item) => item.id === runId);
    return run ? clone(run) : null;
  }

  async triggerPipeline(projectId: string, simulation: SimulationMode = "success") {
    const store = this.getStore();
    const project = store.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found.");
    }

    const currentRuns = store.runs.filter((run) => run.projectId === projectId);
    const number = Math.max(0, ...currentRuns.map((run) => run.number)) + 1;
    const run: PipelineRun = {
      id: `run-${project.slug}-${Date.now()}`,
      projectId,
      number,
      branch: project.repo.branch,
      commitSha: number.toString(16).padStart(7, "0"),
      commitMessage: simulation === "failure" ? "Demo a failed release diagnosis" : "Deploy the latest repository commit",
      triggeredBy: "Aarav Shah",
      triggerType: "manual",
      status: "queued",
      startedAt: new Date().toISOString(),
      workflowUrl: `https://github.com/${project.repo.owner}/${project.repo.name}/actions/runs/${number}`,
      stages: makeStages(Array(6).fill("pending") as StageStatus[]),
      simulation,
      failureReason: simulation === "failure" ? "The image registry rejected the package write permission." : undefined,
    };
    store.runs.unshift(run);
    store.logs[run.id] = [
      { id: `${run.id}-1`, timestamp: new Date().toISOString(), level: "info", source: "queue", message: "Pipeline accepted and queued for execution" },
      { id: `${run.id}-2`, timestamp: new Date().toISOString(), level: "info", source: "checkout", message: `Waiting to check out ${project.repo.owner}/${project.repo.name}@${project.repo.branch}` },
    ];
    project.latestRunId = run.id;
    project.status = "degraded";
    if (simulation === "failure") {
      store.insights.unshift({
        id: `insight-${run.id}`,
        projectId,
        runId: run.id,
        severity: "critical",
        title: "The release is likely to fail at the registry",
        summary: "This demonstration run includes a package permission failure so the troubleshooting experience can be reviewed before backend integration.",
        probableCause: "The workflow token does not have permission to publish the container package.",
        recommendedAction: "Add packages:write to the workflow permissions and confirm the repository can publish to the selected registry.",
        confidence: 92,
        createdAt: new Date().toISOString(),
        evidence: ["The test stage is expected to pass", "The image push stage is configured to fail", "Deployment will remain pending until the image is available"],
      });
    }
    this.persist();
    return clone(run);
  }

  async cancelPipeline(runId: string) {
    const store = this.getStore();
    const run = store.runs.find((item) => item.id === runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) {
      return run ? clone(run) : null;
    }
    run.status = "canceled";
    run.finishedAt = new Date().toISOString();
    run.duration = formatDuration(run.startedAt);
    run.stages = run.stages.map((stage) =>
      stage.status === "running" || stage.status === "pending"
        ? { ...stage, status: "skipped", detail: "Canceled by user" }
        : stage,
    );
    this.persist();
    return clone(run);
  }

  async redeploy(deploymentId: string) {
    const store = this.getStore();
    const deployment = store.deployments.find((item) => item.id === deploymentId);
    if (!deployment) {
      return null;
    }
    deployment.status = "healthy";
    deployment.finishedAt = new Date().toISOString();
    deployment.createdAt = new Date().toISOString();
    deployment.healthScore = 100;
    deployment.readyReplicas = deployment.replicas;
    const project = store.projects.find((item) => item.id === deployment.projectId);
    if (project) {
      project.status = "healthy";
      store.health[project.id] = (store.health[project.id] ?? []).map((check) => ({
        ...check,
        status: "passing",
        detail: check.name === "Deployment rollout" ? `${deployment.replicas} of ${deployment.replicas} replicas ready` : check.detail,
      }));
    }
    this.persist();
    return clone(deployment);
  }

  async listDeployments(projectId: string) {
    return clone(this.syncRuns().deployments.filter((deployment) => deployment.projectId === projectId));
  }

  async getDeploymentLogs(deploymentId: string) {
    const deployment = this.getStore().deployments.find((item) => item.id === deploymentId);
    return deployment ? this.getPipelineLogs(deployment.runId) : [];
  }

  async getPipelineLogs(runId: string) {
    const logs = this.getStore().logs[runId] ?? [];
    return clone(logs);
  }

  async getHealthChecks(projectId: string) {
    const health = this.getStore().health[projectId] ?? [];
    return clone(health);
  }

  async getAiInsights(projectId: string) {
    return clone(this.getStore().insights.filter((insight) => insight.projectId === projectId));
  }
}
