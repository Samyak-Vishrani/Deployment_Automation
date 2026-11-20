import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/api/http-error";

const { reveal, put } = vi.hoisted(() => ({ reveal: vi.fn(), put: vi.fn() }));

vi.mock("@/lib/auth/current-user", () => ({ requireUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/runtime", () => ({
  ensureBootstrapped: async () => undefined,
  services: () => ({ envVars: { reveal, put } }),
}));

import { GET } from "./[key]/route";
import { PUT } from "./route";

const ctx = (key?: string) => ({ params: Promise.resolve({ projectId: "p1", componentId: "c1", key: key ?? "" }) });

beforeEach(() => {
  reveal.mockReset();
  put.mockReset();
});

describe("component env routes", () => {
  it("reveals a non-secret value with no-store, and maps env_secret to 403", async () => {
    reveal.mockResolvedValueOnce({ key: "GREETING", value: "hi" });
    const ok = await GET(new Request("http://x"), ctx("GREETING"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(reveal).toHaveBeenCalledWith("u1", "p1", "c1", "GREETING");

    reveal.mockRejectedValueOnce(new HttpError("TOKEN is a secret.", 403, "env_secret"));
    const secret = await GET(new Request("http://x"), ctx("TOKEN"));
    expect(secret.status).toBe(403);
    expect(await secret.json()).toEqual({ error: "env_secret", message: "TOKEN is a secret." });
  });

  it("refuses a malformed body before touching the service", async () => {
    const response = await PUT(new Request("http://x", { method: "PUT", body: "not json" }), ctx());
    expect(response.status).toBe(400);
    expect(put).not.toHaveBeenCalled();

    put.mockResolvedValueOnce({ projectId: "p1", shared: [], components: [] });
    const saved = await PUT(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ vars: [{ key: "A", value: "1", isSecret: false }] }) }),
      ctx(),
    );
    expect(saved.status).toBe(200);
    expect(put).toHaveBeenCalledWith("u1", "p1", "c1", { vars: [{ key: "A", value: "1", isSecret: false }] });
  });
});
