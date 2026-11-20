import { beforeEach, describe, expect, it, vi } from "vitest";

const { getOwnedDeployment, entries, openStream } = vi.hoisted(() => ({
  getOwnedDeployment: vi.fn(),
  entries: vi.fn(),
  openStream: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({ requireUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/deployments/access", () => ({ getOwnedDeployment }));
vi.mock("@/lib/runtime", () => ({ services: () => ({ logs: { entries, openStream } }) }));

import { GET } from "./route";

const ctx = { params: Promise.resolve({ deploymentId: "d1" }) };
const entry = (seq: number, text: string) => ({ seq, at: 1, source: "render", phase: "build", stream: "stdout", text });
const read = async (res: Response) => res.text();

beforeEach(() => {
  getOwnedDeployment.mockReset();
  entries.mockReset();
  openStream.mockReset();
});

describe("build-log stream route", () => {
  it("replays a finished deployment from the logs service with seq ids, then done with its status", async () => {
    getOwnedDeployment.mockResolvedValue({ id: "d1", projectId: "p1", status: "failed" });
    entries.mockResolvedValue({ entries: [entry(4, "a"), entry(5, "b")], nextSeq: 5, complete: false });

    const res = await GET(new Request("http://x/api/deployments/d1/logs/stream", { headers: { "last-event-id": "3" } }), ctx);
    const body = await read(res);

    expect(entries).toHaveBeenCalledWith("p1", "d1", { afterSeq: 3, limit: 5000 });
    expect(body).toContain('id: 4\nevent: entry\ndata: {"seq":4');
    expect(body).toContain("id: 5\nevent: entry");
    expect(body.trim().endsWith('event: done\ndata: {"status":"failed"}')).toBe(true);
    expect(openStream).not.toHaveBeenCalled();
  });

  it("tails a running deployment through the logs service's NDJSON stream", async () => {
    getOwnedDeployment.mockResolvedValue({ id: "d1", projectId: "p1", status: "running" });
    openStream.mockResolvedValue(
      new Response(
        [{ type: "entry", entry: entry(1, "x") }, { type: "heartbeat" }, { type: "done", status: "success" }].map((e) => JSON.stringify(e)).join("\n") + "\n",
      ),
    );
    const res = await GET(new Request("http://x/api/deployments/d1/logs/stream?afterSeq=0"), ctx);
    const body = await read(res);
    expect(openStream).toHaveBeenCalledWith("p1", "d1", 0, expect.any(AbortSignal));
    expect(body).toContain("id: 1\nevent: entry");
    expect(body).toContain('event: done\ndata: {"status":"success"}');
  });

  it("answers a JSON error when the logs service is down", async () => {
    const { HttpError } = await import("@/lib/api/http-error");
    getOwnedDeployment.mockResolvedValue({ id: "d1", projectId: "p1", status: "running" });
    openStream.mockRejectedValue(new HttpError("The logs service is not running.", 503, "logs_service_unavailable"));
    const res = await GET(new Request("http://x/api/deployments/d1/logs/stream"), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "logs_service_unavailable", message: "The logs service is not running." });
  });
});
