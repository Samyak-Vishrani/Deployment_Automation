import { EventEmitter } from "node:events";

export type AppEvent =
  | { kind: "deployment"; projectId: string; deploymentId: string; status: string }
  | { kind: "project"; projectId: string; action: "created" | "updated" | "deleted" }
  /** A "Deploy all" (Phase 8) moved on: its status, and the stage now running (0 db, 1 backend, 2 frontend, 3 done). */
  | { kind: "release"; projectId: string; releaseId: string; status: string; stage: number }
  /** An App installation or its repository selection changed; repository lists refetch. */
  | { kind: "github"; action: string };

const CHANNEL = "app-event";

/**
 * A single app-wide change feed.
 *
 * Events carry identifiers and a status, never whole records. The client
 * refetches what it needs, so there is exactly one shape of a Project in the
 * codebase - the API response - rather than a second one that drifts from it.
 * The payload is small enough that the extra round trip costs nothing at this
 * scale, and it means a client that reconnects after missing events still
 * converges on the truth.
 */
export class EventsService {
  // Every open browser tab is a listener, so the default cap of 10 would
  // produce a spurious leak warning.
  private readonly bus = new EventEmitter().setMaxListeners(0);

  emit(event: AppEvent): void {
    this.bus.emit(CHANNEL, event);
  }

  deploymentChanged(projectId: string, deploymentId: string, status: string): void {
    this.emit({ kind: "deployment", projectId, deploymentId, status });
  }

  projectChanged(projectId: string, action: "created" | "updated" | "deleted"): void {
    this.emit({ kind: "project", projectId, action });
  }

  releaseChanged(projectId: string, releaseId: string, status: string, stage: number): void {
    this.emit({ kind: "release", projectId, releaseId, status, stage });
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.bus.on(CHANNEL, listener);
    return () => this.bus.off(CHANNEL, listener);
  }
}
