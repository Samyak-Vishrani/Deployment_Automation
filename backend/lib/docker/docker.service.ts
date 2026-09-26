import Docker from "dockerode";

export const MANAGED_LABEL = "orbitops.managed";
export const PROJECT_LABEL = "orbitops.project";
export const DEPLOYMENT_LABEL = "orbitops.deployment";

export interface RunContainerSpec {
  name: string;
  image: string;
  containerPort: number;
  hostPort: number;
  env: Record<string, string>;
  projectId: string;
  deploymentId: string;
}

/**
 * Thin wrapper over dockerode for container lifecycle.
 *
 * Images are built by shelling out to the docker CLI instead (see
 * deploy-executor): the CLI honours .dockerignore and drives BuildKit, whereas
 * dockerode's build endpoint would mean hand-rolling the tar context and using
 * the legacy builder. Lifecycle operations are structured, so the library wins
 * there - parsing CLI output for container state would be fragile.
 */
export class DockerService {
  readonly docker: Docker;

  constructor() {
    // Windows needs the pipe named explicitly. Docker Desktop exposes both
    // //./pipe/docker_engine (the classic one dockerode expects) and
    // //./pipe/dockerDesktopLinuxEngine, and dockerode does not discover it the
    // way the CLI does - without this it fails with an opaque ENOENT.
    this.docker =
      process.platform === "win32"
        ? new Docker({ socketPath: "//./pipe/docker_engine" })
        : new Docker();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replaces the container for a project.
   *
   * Returns the image the previous container was running, so a failed start can
   * be rolled back to it.
   */
  async replaceContainer(spec: RunContainerSpec): Promise<{ id: string; previousImage?: string }> {
    const previousImage = await this.removeExisting(spec.name);

    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: {
        [MANAGED_LABEL]: "true",
        [PROJECT_LABEL]: spec.projectId,
        [DEPLOYMENT_LABEL]: spec.deploymentId,
      },
      ExposedPorts: { [`${spec.containerPort}/tcp`]: {} },
      HostConfig: {
        PortBindings: {
          // HostIp is explicit on purpose. dockerode's default of '' means
          // 0.0.0.0, which publishes every deployed app to the whole LAN and
          // has Docker Desktop open the Windows firewall to match.
          [`${spec.containerPort}/tcp`]: [
            { HostIp: "127.0.0.1", HostPort: String(spec.hostPort) },
          ],
        },
        RestartPolicy: { Name: "unless-stopped" },
      },
    });

    try {
      await container.start();
    } catch (error) {
      // Never leave a created-but-unstarted container holding the name.
      await container.remove({ force: true }).catch(() => undefined);
      throw error;
    }

    return { id: container.id, previousImage };
  }

  /**
   * Waits for the container to be genuinely up.
   *
   * Without this a container that crashes on boot would be reported as a
   * successful deployment: start() resolves as soon as the process is
   * launched, not when it survives.
   */
  async waitUntilHealthy(
    name: string,
    timeoutMs = 60_000,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const container = this.docker.getContainer(name);
    const started = Date.now();
    const deadline = started + timeoutMs;
    /** How long an image with no HEALTHCHECK must stay up to count as started. */
    const settleMs = 3000;
    let sawHealthcheck = false;

    while (Date.now() < deadline) {
      const state = (await container.inspect()).State;

      if (!state.Running) {
        return {
          ok: false,
          reason:
            `container exited with code ${state.ExitCode}` +
            (state.Error ? `: ${state.Error}` : ""),
        };
      }

      const health = state.Health?.Status;
      if (health) {
        // The image declares a HEALTHCHECK, which is a far better signal than
        // "the process has not exited yet" - so wait for its verdict.
        sawHealthcheck = true;
        if (health === "healthy") return { ok: true };
        if (health === "unhealthy") return { ok: false, reason: "HEALTHCHECK reported unhealthy" };
        // 'starting' - keep waiting.
      } else if (Date.now() - started >= settleMs) {
        // No HEALTHCHECK to consult. Surviving the settle window is the only
        // evidence available, and it does catch the common case: a container
        // that crashes immediately on a missing env var or a bad command.
        return { ok: true };
      }

      await delay(500);
    }

    return {
      ok: false,
      reason: sawHealthcheck
        ? `HEALTHCHECK did not report healthy within ${timeoutMs / 1000}s`
        : `container did not start within ${timeoutMs / 1000}s`,
    };
  }

  /** Last lines of a container's own output, for diagnosing a failed start. */
  async containerLogs(name: string, tail = 50): Promise<string> {
    try {
      const buffer = (await this.docker.getContainer(name).logs({
        stdout: true,
        stderr: true,
        tail,
      })) as unknown as Buffer;
      // Non-TTY containers multiplex streams with an 8-byte header per frame;
      // stripping non-printables is enough for a human-readable tail.
      return buffer.toString("utf8").replace(/[\x00-\x08\x0b-\x1f]/g, "");
    } catch {
      return "";
    }
  }

  /** Removes the named container if present, returning the image it ran. */
  async removeExisting(name: string): Promise<string | undefined> {
    try {
      const container = this.docker.getContainer(name);
      const info = await container.inspect();
      const image = info.Config?.Image;
      await container.stop({ t: 10 }).catch(() => undefined); // 304 if already stopped
      await container.remove({ force: true });
      return image;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async stopProjectContainer(projectId: string, name: string): Promise<void> {
    await this.removeExisting(name);
    console.log(`[docker] Removed container ${name} for project ${projectId}.`);
  }

  /** Deletes all but the newest `keep` images for a project. */
  async pruneImages(imagePrefix: string, keep = 3): Promise<void> {
    try {
      const images = await this.docker.listImages({
        filters: { label: [`${MANAGED_LABEL}=true`] },
      });
      const mine = images
        .filter((img) => (img.RepoTags ?? []).some((t) => t.startsWith(`${imagePrefix}:`)))
        .sort((a, b) => b.Created - a.Created)
        .slice(keep);

      for (const image of mine) {
        for (const tag of image.RepoTags ?? []) {
          if (tag.startsWith(`${imagePrefix}:`) && !tag.endsWith(":latest")) {
            await this.docker.getImage(tag).remove().catch(() => undefined);
          }
        }
      }
    } catch (error) {
      console.warn(`[docker] Image prune failed: ${(error as Error).message}`);
    }
  }

  /** Removes managed containers whose project no longer exists. */
  async sweepOrphans(liveProjectIds: Set<string>): Promise<number> {
    let removed = 0;
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`${MANAGED_LABEL}=true`] },
      });
      for (const info of containers) {
        const projectId = info.Labels?.[PROJECT_LABEL];
        if (projectId && !liveProjectIds.has(projectId)) {
          await this.docker.getContainer(info.Id).remove({ force: true }).catch(() => undefined);
          removed++;
        }
      }
      if (removed > 0) {
        console.log(`[docker] Removed ${removed} orphaned container(s).`);
      }
    } catch (error) {
      console.warn(`[docker] Orphan sweep failed: ${(error as Error).message}`);
    }
    return removed;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
