import { ProviderError } from "@orbitops/integration-common/provider-error";
import { describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "../neon/neon.provider";
import { fakeDb, type FakeDb } from "../test-support/fake-db";
import { parseDatabaseRequest } from "./database-input";
import { DatabasesService } from "./databases.service";

const SCOPE = { apiKey: "napi_key", orgId: "org-1", regionId: "aws-us-west-2", pgVersion: 17 };
const REQUEST = { userId: "u1", componentId: "c1", projectName: "Vercel_Integration_test", componentName: "database" };

function info(id = "young-sun-1"): ProjectInfo {
  return {
    neonProjectId: id,
    name: "vercel-integration-test-database",
    regionId: "aws-us-west-2",
    pgVersion: 17,
    orgId: "org-1",
    branchId: "br-1",
    databaseName: "neondb",
    roleName: "neondb_owner",
    host: "ep-1.us-west-2.aws.neon.tech",
  };
}

function setup(db: FakeDb = fakeDb()) {
  const neon = {
    findProject: vi.fn(
      async (_ctx: unknown, id: string): Promise<{ neonProjectId: string; name: string; regionId: string; pgVersion: number } | null> => ({
        neonProjectId: id,
        name: "x",
        regionId: "r",
        pgVersion: 17,
      }),
    ),
    createProject: vi.fn(async () => info()),
    waitForOperations: vi.fn(async () => undefined),
    getConnection: vi.fn(async () => ({
      pooledUri: "postgresql://o:pw@ep-1-pooler/neondb",
      directUri: "postgresql://o:pw@ep-1/neondb",
    })),
    deleteProject: vi.fn(async () => undefined),
  };
  const credentials = { getKey: vi.fn(async () => SCOPE), markInvalid: vi.fn(async () => undefined) };
  const service = new DatabasesService(db, neon, credentials, { provisionTimeoutMs: 60_000, now: () => 5_000 });
  return { db, neon, credentials, service };
}

describe("DatabasesService.ensure", () => {
  it("creates the project with the user's defaults, records it, waits, and reports it ready", async () => {
    const { db, neon, service } = setup();
    let stateWhileWaiting: unknown;
    neon.waitForOperations.mockImplementation(async () => {
      stateWhileWaiting = db.neonDatabase.rows[0]?.state;
    });

    const view = await service.ensure(REQUEST);

    expect(neon.createProject).toHaveBeenCalledWith(
      { apiKey: "napi_key" },
      { name: "vercel-integration-test-database", regionId: "aws-us-west-2", pgVersion: 17, orgId: "org-1" },
    );
    // Persisted before waiting, so an interrupted call resumes instead of creating twice.
    expect(stateWhileWaiting).toBe("provisioning");
    expect(neon.waitForOperations).toHaveBeenCalledWith({ apiKey: "napi_key" }, "young-sun-1", { timeoutMs: 60_000, since: 5_000 });
    expect(view).toMatchObject({
      componentId: "c1",
      state: "ready",
      neonProjectId: "young-sun-1",
      databaseName: "neondb",
      roleName: "neondb_owner",
      consoleUrl: "https://console.neon.tech/app/projects/young-sun-1",
      created: true,
      warning: null,
    });
    expect(JSON.stringify(view)).not.toContain("pw");
  });

  it("returns a ready database without creating or waiting again", async () => {
    const { neon, service } = setup();
    await service.ensure(REQUEST);
    neon.createProject.mockClear();
    neon.waitForOperations.mockClear();

    await expect(service.ensure(REQUEST)).resolves.toMatchObject({ state: "ready", created: false });
    expect(neon.createProject).not.toHaveBeenCalled();
    expect(neon.waitForOperations).not.toHaveBeenCalled();
  });

  it("serialises concurrent calls for one component, so only one project is created", async () => {
    const { neon, service } = setup();
    const [a, b] = await Promise.all([service.ensure(REQUEST), service.ensure(REQUEST)]);
    expect(neon.createProject).toHaveBeenCalledTimes(1);
    expect([a.created, b.created]).toEqual([true, false]);
  });

  it("recreates a project deleted on Neon, with a warning", async () => {
    const { db, neon, service } = setup();
    await service.ensure(REQUEST);
    neon.findProject.mockResolvedValueOnce(null);
    neon.createProject.mockResolvedValueOnce(info("young-sun-2"));

    const view = await service.ensure(REQUEST);
    expect(view).toMatchObject({ neonProjectId: "young-sun-2", created: true, state: "ready" });
    expect(view.warning).toMatch(/deleted on Neon.*empty/);
    expect(db.neonDatabase.rows).toHaveLength(1);
  });

  it("leaves a timed-out project provisioning, and the next call waits again without creating", async () => {
    const { db, neon, service } = setup();
    neon.waitForOperations.mockRejectedValueOnce(
      new ProviderError("still setting up", 504, "neon_provision_timeout", { retryable: true }),
    );
    await expect(service.ensure(REQUEST)).rejects.toMatchObject({ code: "neon_provision_timeout" });
    expect(db.neonDatabase.rows[0].state).toBe("provisioning");

    await expect(service.ensure(REQUEST)).resolves.toMatchObject({ state: "ready", created: false });
    expect(neon.createProject).toHaveBeenCalledTimes(1);
    expect(neon.waitForOperations).toHaveBeenLastCalledWith(expect.anything(), "young-sun-1", {
      timeoutMs: 60_000,
      since: undefined,
    });
  });

  it("marks a failed setup, then replaces the empty project on the next call", async () => {
    const { db, neon, service } = setup();
    neon.waitForOperations.mockRejectedValueOnce(new ProviderError("start compute failed", 502, "neon_provision_failed"));
    await expect(service.ensure(REQUEST)).rejects.toMatchObject({ code: "neon_provision_failed" });
    expect(db.neonDatabase.rows[0]).toMatchObject({ state: "failed", lastError: "start compute failed" });

    neon.createProject.mockResolvedValueOnce(info("young-sun-3"));
    const view = await service.ensure(REQUEST);
    expect(neon.deleteProject).toHaveBeenCalledWith({ apiKey: "napi_key" }, "young-sun-1");
    expect(view).toMatchObject({ neonProjectId: "young-sun-3", state: "ready", lastError: null });
    expect(view.warning).toMatch(/created again/);
  });

  it("marks the key invalid when Neon rejects it", async () => {
    const { credentials, neon, service } = setup();
    neon.createProject.mockRejectedValueOnce(new ProviderError("rejected", 412, "neon_key_invalid", { invalidToken: true }));
    await expect(service.ensure(REQUEST)).rejects.toMatchObject({ code: "neon_key_invalid" });
    expect(credentials.markInvalid).toHaveBeenCalledWith("u1");
  });

  it("never touches another user's database", async () => {
    const { service } = setup();
    await service.ensure(REQUEST);
    await expect(service.ensure({ ...REQUEST, userId: "u2" })).rejects.toMatchObject({ status: 404 });
    await expect(service.get("u2", "c1")).rejects.toMatchObject({ status: 404 });
    await expect(service.connection("u2", "c1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("DatabasesService.connection and destroy", () => {
  it("fetches the connection strings fresh for a ready database", async () => {
    const { neon, service } = setup();
    await service.ensure(REQUEST);
    await expect(service.connection("u1", "c1")).resolves.toEqual({
      pooledUri: "postgresql://o:pw@ep-1-pooler/neondb",
      directUri: "postgresql://o:pw@ep-1/neondb",
    });
    expect(neon.getConnection).toHaveBeenCalledWith(
      { apiKey: "napi_key" },
      expect.objectContaining({ neonProjectId: "young-sun-1", branchId: "br-1", databaseName: "neondb", roleName: "neondb_owner" }),
    );
  });

  it("refuses a database that is not ready", async () => {
    const { neon, service } = setup();
    neon.waitForOperations.mockRejectedValueOnce(new ProviderError("slow", 504, "neon_provision_timeout"));
    await service.ensure(REQUEST).catch(() => undefined);
    await expect(service.connection("u1", "c1")).rejects.toMatchObject({ status: 409, code: "neon_database_not_ready" });
  });

  it("deletes the Neon project and forgets it", async () => {
    const { db, neon, service } = setup();
    await service.ensure(REQUEST);
    await expect(service.destroy("u1", "c1")).resolves.toEqual({ deleted: true });
    expect(neon.deleteProject).toHaveBeenCalledWith({ apiKey: "napi_key" }, "young-sun-1");
    expect(db.neonDatabase.rows).toHaveLength(0);
  });
});

describe("parseDatabaseRequest", () => {
  it("validates ids and names", () => {
    expect(parseDatabaseRequest(REQUEST)).toEqual(REQUEST);
    expect(() => parseDatabaseRequest({ ...REQUEST, componentId: "../x" })).toThrow(/componentId/);
    expect(() => parseDatabaseRequest({ ...REQUEST, projectName: "" })).toThrow(/projectName/);
    expect(() => parseDatabaseRequest({ ...REQUEST, extra: true })).toThrow(/Unknown field/);
  });
});
