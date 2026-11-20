// Copied from backend/vercel_integration/src/callbacks/outbox.test.ts. Each integration service builds and
// deploys on its own, so shared plumbing is copied, not imported. Keep the copies in step.

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeDb } from "../test-support/fake-db";
import type { EventBatch } from "../types";
import { CallbackClient, signBody, type CallbackSender, type DeliveryResult } from "./callback-client";
import { EventOutbox } from "./outbox";

async function seed(db: FakeDb, deploymentId = "dep1") {
  await db.renderDeployment.create({
    data: { deploymentId, userId: "u1", componentId: "c1", input: {}, state: "queued" },
  });
}

function recorder(results: DeliveryResult[] = []) {
  const sent: EventBatch[] = [];
  const sender: CallbackSender = {
    send: vi.fn(async (batch: EventBatch) => {
      sent.push(structuredClone(batch));
      return results.shift() ?? "delivered";
    }),
  };
  return { sent, sender };
}

describe("EventOutbox", () => {
  let db: FakeDb;
  beforeEach(async () => {
    db = fakeDb();
    await seed(db);
  });

  it("batches log lines and sends a status change together with the lines before it, in order", async () => {
    const { sent, sender } = recorder();
    const outbox = new EventOutbox(db, sender, { flushIntervalMs: 10_000, sleep: async () => undefined });

    outbox.push("dep1", { type: "logs", lines: [{ at: 1, stream: "stdout", text: "a" }] });
    outbox.push("dep1", { type: "logs", lines: [{ at: 2, stream: "stdout", text: "b" }] });
    outbox.push("dep1", { type: "status", providerStatus: "building" });
    outbox.push("dep1", { type: "terminal", status: "live", productionUrl: "https://x.onrender.com" });
    await outbox.drain("dep1");

    expect(sent.map((b) => b.seq)).toEqual([1, 2]);
    expect(sent[0].events).toEqual([
      { type: "logs", lines: [{ at: 1, stream: "stdout", text: "a" }, { at: 2, stream: "stdout", text: "b" }] },
      { type: "status", providerStatus: "building" },
    ]);
    expect(sent[1].events[0]).toMatchObject({ type: "terminal", status: "live" });
    // Acknowledged batches are no longer pending.
    expect(db.renderDeployment.rows[0].pendingEvents).toEqual([]);
  });

  it("keeps retrying until the main backend accepts, then clears the batch", async () => {
    const { sent, sender } = recorder(["retry", "retry", "delivered"]);
    const outbox = new EventOutbox(db, sender, { sleep: async () => undefined });

    outbox.push("dep1", { type: "status", providerStatus: "deploying" });
    await outbox.drain("dep1");

    expect(sent).toHaveLength(3);
    expect(db.renderDeployment.rows[0].pendingEvents).toEqual([]);
  });

  it("leaves an undelivered batch persisted, and re-sends it on the next start", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const failing: CallbackSender = { send: vi.fn(async () => "retry" as const) };
    const outbox = new EventOutbox(db, failing, {
      giveUpAfterMs: 1000,
      sleep: async () => {
        now += 600;
      },
    });

    outbox.push("dep1", { type: "status", providerStatus: "deploying" });
    await outbox.drain("dep1");
    vi.restoreAllMocks();
    expect(db.renderDeployment.rows[0].pendingEvents).toHaveLength(1);

    const { sent, sender } = recorder();
    const restarted = new EventOutbox(db, sender, { sleep: async () => undefined });
    await expect(restarted.redeliverPending()).resolves.toBe(1);
    await restarted.drain("dep1");
    expect(sent.map((b) => b.seq)).toEqual([1]);
    expect(db.renderDeployment.rows[0].pendingEvents).toEqual([]);
  });

  it("drops a batch the main backend rejects for good", async () => {
    const { sender } = recorder(["rejected"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outbox = new EventOutbox(db, sender, { sleep: async () => undefined });
    outbox.push("dep1", { type: "status", providerStatus: "deploying" });
    await outbox.drain("dep1");
    expect(db.renderDeployment.rows[0].pendingEvents).toEqual([]);
    warn.mockRestore();
  });
});

describe("CallbackClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs the exact body it sends", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const batch: EventBatch = { deploymentId: "dep1", seq: 3, events: [{ type: "status", providerStatus: "live" }] };

    await expect(new CallbackClient("http://main.test", "s3cret").send(batch)).resolves.toBe("delivered");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://main.test/api/internal/provider-events");
    const expected = `sha256=${createHmac("sha256", "s3cret").update(init.body as string).digest("hex")}`;
    expect((init.headers as Record<string, string>)["x-orbitops-signature"]).toBe(expected);
    expect(signBody("s3cret", init.body as string)).toBe(expected);
    // The backend picks RENDER_CALLBACK_SECRET (not Vercel's) because of this header.
    expect((init.headers as Record<string, string>)["x-orbitops-provider"]).toBe("render");
  });

  it("classifies responses", async () => {
    const statuses = [404, 401, 503];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: statuses.shift() })));
    const client = new CallbackClient("http://main.test", "s");
    const batch: EventBatch = { deploymentId: "d", seq: 1, events: [] };
    await expect(client.send(batch)).resolves.toBe("rejected");
    await expect(client.send(batch)).resolves.toBe("retry");
    await expect(client.send(batch)).resolves.toBe("retry");

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("ECONNREFUSED"))));
    await expect(client.send(batch)).resolves.toBe("retry");
  });
});
