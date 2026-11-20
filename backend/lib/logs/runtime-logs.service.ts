import type { Component, PrismaClient, Project } from "@prisma/client";
import { HttpError, notFound } from "@/lib/api/http-error";
import { redact } from "@/lib/common/redact";
import type { EnvVarsService } from "@/lib/env/env-vars.service";
import type { NeonClient } from "@/lib/providers/provider-deployments.service";
import type { LogsServiceClient, RuntimeStreamOptions } from "./logs-service.client";
import type { LogSource, RuntimeLogEvent, RuntimeLogLine } from "./log-types";
import { readNdjson } from "./ndjson";

/** A runtime line as the browser gets it: the provider's line, plus who it came from. */
export type RuntimeLogEntry = RuntimeLogLine & { source: LogSource };

export type BrowserRuntimeEvent =
  | { type: "entry"; entry: RuntimeLogEntry }
  | { type: "notice"; text: string }
  | { type: "end"; reason: string; message: string };

export interface OpenedRuntime {
  sessionId: string;
  source: LogSource;
  events: AsyncGenerator<BrowserRuntimeEvent>;
}

export const NEON_RUNTIME_NOTE =
  "Neon has no runtime log API. See the Monitoring tab of the project in the Neon console.";

/**
 * Live runtime logs of ONE component (or the project's local Docker
 * container), Phase 12. The logs service (backend/logs) does the tailing; this
 * checks the user owns what they ask for, and redacts the component's secret
 * env values (and a backend's Neon connection strings) from every line before
 * it reaches the browser, because only this backend knows them.
 */
export class RuntimeLogsService {
  /** sessionId → userId, so only the owner can keep a stream alive. */
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: Pick<LogsServiceClient, "openRuntime" | "openDockerRuntime" | "ping">,
    private readonly envVars: Pick<EnvVarsService, "resolve">,
    private readonly neon?: Pick<NeonClient, "getConnection">,
  ) {}

  /** `componentId` null = the project's local Docker container. */
  async open(
    userId: string,
    projectId: string,
    componentId: string | null,
    options: RuntimeStreamOptions,
    signal: AbortSignal,
  ): Promise<OpenedRuntime> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== userId) throw notFound(`Project ${projectId} not found.`);

    let component: Component | null = null;
    if (componentId) {
      component = await this.prisma.component.findUnique({ where: { id: componentId } });
      if (!component || component.projectId !== projectId) throw notFound(`Component ${componentId} not found.`);
      if (component.provider === "neon") {
        throw new HttpError(NEON_RUNTIME_NOTE, 400, "runtime_logs_unsupported");
      }
    }

    const secrets = await this.secretsFor(project, component);
    let response: Response;
    let source: LogSource;
    if (component && (component.provider === "vercel" || component.provider === "render")) {
      response = await this.client.openRuntime(userId, component.id, component.provider, options, signal);
      source = component.provider;
    } else {
      response = await this.client.openDockerRuntime(userId, containerName(project), options, signal);
      source = "docker";
    }

    const sessionId = response.headers.get("x-session-id") ?? "";
    if (sessionId) this.owners.set(sessionId, userId);
    const owners = this.owners;
    const events = (async function* (): AsyncGenerator<BrowserRuntimeEvent> {
      try {
        for await (const event of readNdjson<RuntimeLogEvent>(response.body, signal)) {
          if (event.type === "line") {
            yield { type: "entry", entry: { ...event.line, text: redact(event.line.text, secrets), source } };
          } else if (event.type === "notice") {
            yield { type: "notice", text: redact(event.text, secrets) };
          } else if (event.type === "end") {
            yield { type: "end", reason: event.reason, message: redact(event.message, secrets) };
            return;
          }
        }
      } finally {
        owners.delete(sessionId);
      }
    })();
    return { sessionId, source, events };
  }

  /** The viewer is still watching. */
  async ping(userId: string, sessionId: string): Promise<{ ok: true }> {
    if (this.owners.get(sessionId) !== userId) throw notFound("That log stream has ended.");
    return this.client.ping(sessionId);
  }

  /**
   * Values to scrub: the env secrets the component (or, for Docker, the
   * project's shared set) is deployed with, and a Render backend's Neon
   * connection strings. Fetched once per stream; a failure only means less
   * redaction context, never a refused stream.
   */
  private async secretsFor(project: Project, component: Component | null): Promise<string[]> {
    const secrets: string[] = [];
    try {
      secrets.push(...(await this.envVars.resolve(project.id, component)).secrets);
    } catch {
      // No env context: the logs service's generic redaction still applies.
    }
    if (component?.kind === "backend" && component.provider === "render" && this.neon) {
      const database = await this.prisma.component.findFirst({ where: { projectId: project.id, kind: "database", provider: "neon" } });
      if (database?.providerResourceId) {
        try {
          const connection = await this.neon.getConnection(project.userId, database.id);
          secrets.push(connection.pooledUri, connection.directUri);
        } catch {
          // Neon unreachable: the generic redaction catches URLs with passwords.
        }
      }
    }
    return secrets;
  }
}

/** The local Docker container of a project, as DeployExecutor names it. */
export function containerName(project: Pick<Project, "slug" | "id">): string {
  return `orbitops-${(project.slug ?? project.id).toLowerCase()}`;
}
