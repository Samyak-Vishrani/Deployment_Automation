import { describe, expect, it } from "vitest";
import { DeployQueue } from "./deploy-queue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DeployQueue", () => {
  it("runs one job per component at a time, different components in parallel", async () => {
    const queue = new DeployQueue(4);
    const running = new Set<string>();
    const order: string[] = [];
    const release = new Map<string, () => void>();

    queue.setRunner(
      (job) =>
        new Promise<void>((resolve) => {
          running.add(job.deploymentId);
          order.push(job.deploymentId);
          release.set(job.deploymentId, () => {
            running.delete(job.deploymentId);
            resolve();
          });
        }),
    );

    queue.add({ deploymentId: "a1", componentId: "A" });
    queue.add({ deploymentId: "a2", componentId: "A" });
    queue.add({ deploymentId: "b1", componentId: "B" });
    await tick();
    expect([...running].sort()).toEqual(["a1", "b1"]);

    release.get("a1")!();
    await tick();
    expect(running.has("a2")).toBe(true);
    expect(order).toEqual(["a1", "b1", "a2"]);
  });

  it("does not queue the same deployment twice", () => {
    const queue = new DeployQueue();
    expect(queue.add({ deploymentId: "x", componentId: "A" })).toBe(true);
    expect(queue.add({ deploymentId: "x", componentId: "A" })).toBe(false);
  });

  it("aborts a running job with reason cancel, and removes a waiting one", async () => {
    const queue = new DeployQueue(1);
    let reason: unknown;
    queue.setRunner(
      (_job, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => {
            reason = signal.reason;
            resolve();
          }),
        ),
    );
    queue.add({ deploymentId: "run", componentId: "A" });
    queue.add({ deploymentId: "wait", componentId: "B" });
    await tick();

    expect(queue.cancel("wait")).toBe("removed");
    expect(queue.cancel("run")).toBe("aborted");
    await tick();
    expect(reason).toBe("cancel");
    expect(queue.cancel("nope")).toBe("not-found");
  });

  it("drain aborts with reason shutdown", async () => {
    const queue = new DeployQueue();
    let reason: unknown;
    queue.setRunner(
      (_job, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => {
            reason = signal.reason;
            resolve();
          }),
        ),
    );
    queue.add({ deploymentId: "run", componentId: "A" });
    await tick();
    await queue.drain(1000);
    expect(reason).toBe("shutdown");
    expect(queue.add({ deploymentId: "late", componentId: "A" })).toBe(false);
  });
});
