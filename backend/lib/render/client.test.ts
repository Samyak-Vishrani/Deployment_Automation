import { describe, expect, it, vi } from "vitest";
import { RenderClient, deploymentStatus, safeServiceUrl } from "./client";

describe("Render API boundary", () => {
  it("sends credentials only to the fixed API host with no redirects or cache", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "srv-test" }));
    await new RenderClient("secret", fetcher).request("/services", "POST", { name: "test" });
    expect(fetcher).toHaveBeenCalledWith("https://api.render.com/v1/services", expect.objectContaining({ redirect: "error", cache: "no-store", method: "POST", headers: expect.objectContaining({ Authorization: "Bearer secret" }) }));
  });
  it("never leaks provider error bodies", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("password=private", { status: 400 }));
    await expect(new RenderClient("secret", fetcher).request("/services", "POST", {})).rejects.toMatchObject({ uncertain: false, message: expect.not.stringContaining("private") });
  });
  it("marks network write outcomes uncertain without retrying", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("secret token in transport error"));
    await expect(new RenderClient("secret", fetcher).request("/services", "POST", {})).rejects.toMatchObject({ uncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("marks malformed successful write responses uncertain", async () => {
    await expect(new RenderClient("secret", vi.fn().mockResolvedValue(new Response("invalid"))).request("/services", "POST", {})).rejects.toMatchObject({ uncertain: true });
  });
  it("reports rate limiting without echoing raw content", async () => {
    await expect(new RenderClient("secret", vi.fn().mockResolvedValue(new Response("private", { status: 429 }))).request("/owners")).rejects.toMatchObject({ status: 429, uncertain: false });
  });
  it("paginates workspaces", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ owner: { id: `o${i}`, name: `Workspace ${i}` }, cursor: `c${i}` }));
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(page)).mockResolvedValueOnce(Response.json([{ owner: { id: "last", name: "Last" } }]));
    expect(await new RenderClient("secret", fetcher).owners()).toHaveLength(101);
    expect(fetcher.mock.calls[1][0]).toContain("cursor=c99");
  });
  it.each(["https://evil.test", "javascript:alert(1)", "https://x.onrender.com.evil.test", "https://user:pass@x.onrender.com"])("rejects unsafe service link %s", value => expect(safeServiceUrl(value)).toBeNull());
  it("accepts Render HTTPS origins", () => expect(safeServiceUrl("https://demo.onrender.com/path")).toBe("https://demo.onrender.com"));
  it.each([["live", "live"], ["build_failed", "failed"], ["pre_deploy_failed", "failed"], ["canceled", "cancelled"], ["new_future_status", "deploying"]])("maps %s to %s", (input, expected) => expect(deploymentStatus(input)).toBe(expected));
});
