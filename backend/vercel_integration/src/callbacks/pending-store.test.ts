import { EventOutbox } from "@orbitops/integration-common/outbox";
import type { CallbackSender } from "@orbitops/integration-common/callback-client";
import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "../test-support/fake-db";
import type { EventBatch } from "../types";
import { PrismaPendingStore } from "./pending-store";

/** The shared outbox, on this service's own VercelDeployment rows. */
describe("PrismaPendingStore", () => {
  async function setup() {
    const db = fakeDb();
    await db.vercelDeployment.create({
      data: { deploymentId: "dep1", userId: "u1", componentId: "c1", input: {}, state: "queued" },
    });
    return { db, store: new PrismaPendingStore(db) };
  }

  it("numbers batches from callbackSeq and clears them once delivered", async () => {
    const { db, store } = await setup();
    const sent: EventBatch[] = [];
    const sender: CallbackSender = { send: vi.fn(async (b: EventBatch) => (sent.push(b), "delivered" as const)) };
    const outbox = new EventOutbox(store, sender, { sleep: async () => undefined });

    outbox.push("dep1", { type: "status", providerStatus: "building" });
    outbox.push("dep1", { type: "terminal", status: "live" });
    await outbox.drain("dep1");

    expect(sent.map((b) => b.seq)).toEqual([1, 2]);
    expect(db.vercelDeployment.rows[0].callbackSeq).toBe(2);
    expect(db.vercelDeployment.rows[0].pendingEvents).toEqual([]);
  });

  it("lists only deployments with undelivered batches, and survives a missing row", async () => {
    const { db, store } = await setup();
    await db.vercelDeployment.create({
      data: { deploymentId: "dep2", userId: "u1", componentId: "c2", input: {}, state: "queued" },
    });
    await store.setPending("dep2", [{ deploymentId: "dep2", seq: 1, events: [] }]);

    expect((await store.listPending()).map((r) => r.deploymentId)).toEqual(["dep2"]);
    expect(await store.getPending("gone")).toBeNull();
  });
});
