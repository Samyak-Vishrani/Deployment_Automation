import type { Prisma } from "@prisma/client";
import type { EventBatch } from "@orbitops/integration-common/contract";
import type { PendingEventStore } from "@orbitops/integration-common/outbox";
import type { Db } from "../db";

/**
 * EventOutbox's store (backend/integration_common/src/outbox.ts) on this
 * service's RenderDeployment rows: `callbackSeq` numbers the batches,
 * `pendingEvents` holds the ones not yet acknowledged.
 */
export class PrismaPendingStore implements PendingEventStore {
  constructor(private readonly db: Db) {}

  listPending(): Promise<Array<{ deploymentId: string; pendingEvents: unknown }>> {
    return this.db.renderDeployment.findMany({
      where: { NOT: { pendingEvents: { equals: [] } } },
      select: { deploymentId: true, pendingEvents: true },
    });
  }

  async nextSeq(deploymentId: string): Promise<{ seq: number; pendingEvents: unknown }> {
    const row = await this.db.renderDeployment.update({
      where: { deploymentId },
      data: { callbackSeq: { increment: 1 } },
      select: { callbackSeq: true, pendingEvents: true },
    });
    return { seq: row.callbackSeq, pendingEvents: row.pendingEvents };
  }

  async getPending(deploymentId: string): Promise<unknown | null> {
    const row = await this.db.renderDeployment.findUnique({
      where: { deploymentId },
      select: { pendingEvents: true },
    });
    return row ? row.pendingEvents : null;
  }

  async setPending(deploymentId: string, batches: EventBatch[]): Promise<void> {
    await this.db.renderDeployment.update({
      where: { deploymentId },
      data: { pendingEvents: batches as unknown as Prisma.InputJsonValue },
    });
  }
}
