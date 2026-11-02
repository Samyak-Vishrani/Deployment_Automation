import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "callback_secret_value_for_tests_000000";

const { mockApply } = vi.hoisted(() => ({ mockApply: vi.fn() }));

vi.mock("@/lib/runtime", () => ({
  services: () => ({ providerDeployments: { applyBatch: mockApply } }),
}));

import { HttpError } from "@/lib/api/http-error";
import { POST } from "./route";

function deliver(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return POST(
    new Request("http://localhost/api/internal/provider-events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-orbitops-signature": signature },
      body: raw,
    }),
  );
}

const batch = { deploymentId: "dep1", seq: 1, events: [{ type: "status", providerStatus: "building" }] };

beforeEach(() => {
  vi.stubEnv("INTERNAL_CALLBACK_SECRET", SECRET);
  mockApply.mockReset().mockResolvedValue({ applied: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/internal/provider-events", () => {
  it("applies a correctly signed batch", async () => {
    const response = await deliver(batch);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, applied: true });
    expect(mockApply).toHaveBeenCalledWith(batch);
  });

  it("rejects a batch signed with another secret", async () => {
    const response = await deliver(batch, "wrong_secret");
    expect(response.status).toBe(401);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("rejects a malformed batch with 400, which the sender does not retry", async () => {
    const response = await deliver({ deploymentId: "dep1", seq: 0, events: [] });
    expect(response.status).toBe(400);
  });

  it("passes a 404 through for an unknown deployment", async () => {
    mockApply.mockRejectedValueOnce(new HttpError("Deployment dep1 not found.", 404, "not_found"));
    expect((await deliver(batch)).status).toBe(404);
  });

  it("refuses every callback when the secret is not configured", async () => {
    vi.stubEnv("INTERNAL_CALLBACK_SECRET", "");
    expect((await deliver(batch)).status).toBe(503);
  });
});
