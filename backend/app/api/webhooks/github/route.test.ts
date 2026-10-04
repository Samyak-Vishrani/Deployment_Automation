import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "webhook_secret";

const { mockEmit, mockClearTokens, mockHandlePush, mockMarkAsProcessed } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockClearTokens: vi.fn(),
  mockHandlePush: vi.fn(),
  mockMarkAsProcessed: vi.fn(),
}));

vi.mock("@/lib/auth/users", () => ({ clearGithubTokens: mockClearTokens }));
vi.mock("@/lib/runtime", () => ({
  ensureBootstrapped: async () => undefined,
  services: () => ({
    github: { getConfig: () => ({ webhookSecret: SECRET }) },
    deliveries: { markAsProcessed: mockMarkAsProcessed },
    events: { emit: mockEmit },
    deployments: { handlePush: mockHandlePush },
  }),
}));

import { POST } from "./route";

function deliver(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return POST(
    new Request("http://localhost:3001/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": event,
        "x-github-delivery": `delivery-${Math.random()}`,
        "x-hub-signature-256": signature,
      },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkAsProcessed.mockReturnValue(true);
  mockClearTokens.mockResolvedValue(1);
  mockHandlePush.mockResolvedValue(undefined);
});

describe("POST /api/webhooks/github", () => {
  it.each([
    ["installation", "created"],
    ["installation", "deleted"],
    ["installation_repositories", "added"],
  ])("emits a github event for %s.%s", async (event, action) => {
    const response = await deliver(event, { action, installation: { id: 1 }, sender: { id: 42 } });

    expect(response.status).toBe(200);
    expect(mockEmit).toHaveBeenCalledWith({ kind: "github", action: `${event}.${action}` });
    expect(mockHandlePush).not.toHaveBeenCalled();
  });

  it("clears the sender's tokens when they revoke the authorisation", async () => {
    const response = await deliver("github_app_authorization", { action: "revoked", sender: { id: 42 } });

    expect(response.status).toBe(200);
    expect(mockClearTokens).toHaveBeenCalledWith({ githubUserId: "42" });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("rejects an unsigned installation event", async () => {
    const response = await POST(
      new Request("http://localhost:3001/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ action: "revoked", sender: { id: 42 } }),
        headers: { "x-github-event": "github_app_authorization", "x-hub-signature-256": "sha256=bad" },
      }),
    );

    expect(response.status).toBe(401);
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  it("still hands a push to the deployment pipeline", async () => {
    const response = await deliver("push", { ref: "refs/heads/main", repository: { id: 1 } });

    await expect(response.json()).resolves.toMatchObject({ status: "accepted" });
    expect(mockHandlePush).toHaveBeenCalledTimes(1);
  });
});
