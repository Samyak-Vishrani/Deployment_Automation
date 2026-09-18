import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { ApiError } from "./error";

describe("api client", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed JSON for successful GET requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", service: "backend" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = await api.get<{ status: string; service: string }>("/api/health");

    expect(result).toEqual({ status: "ok", service: "backend" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws ApiError for non-2xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "not_found", message: "Resource missing" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(api.get("/api/missing")).rejects.toMatchObject({
      status: 404,
      message: "Resource missing",
      code: "not_found",
    });
    await expect(api.get("/api/missing")).rejects.toBeInstanceOf(ApiError);
  });

  it("serializes JSON request bodies and sends Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await api.post("/api/example", { hello: "world" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Headers;

    expect(init?.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ hello: "world" }));
  });
});
