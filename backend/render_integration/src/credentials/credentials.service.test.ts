import { describe, expect, it, vi } from "vitest";
import { open } from "../crypto/secret-box";
import { fakeDb } from "../test-support/fake-db";
import type { AccountInfo } from "../render/render.provider";
import { parsePreferencesInput } from "./credential-input";
import { CredentialsService } from "./credentials.service";

const KEY = "rnd_api_key_abcdefghijklmnop";

const account = (overrides: Partial<AccountInfo> = {}): AccountInfo => ({
  accountName: "samyak",
  owners: [
    { id: "tea_1", name: "Club", type: "team" },
    { id: "usr_1", name: "samyak", type: "user" },
  ],
  ...overrides,
});

function setup(info = account()) {
  const db = fakeDb();
  const validate = vi.fn().mockResolvedValue(info);
  return { db, validate, service: new CredentialsService(db, { validateCredentials: validate }) };
}

describe("CredentialsService", () => {
  it("stores the key sealed, starts in the personal workspace with Oregon/Free, and never returns the key", async () => {
    const { db, service } = setup();
    const view = await service.save("user1", KEY);

    expect(view).toMatchObject({
      provider: "render",
      state: "connected",
      accountName: "samyak",
      ownerId: "usr_1",
      ownerName: "samyak",
      region: "oregon",
      plan: "free",
      scopeLocked: false,
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
    const row = db.renderCredential.rows[0];
    expect(row.apiKeyEnc).not.toContain(KEY);
    expect(open(row.apiKeyEnc as string)).toBe(KEY);
  });

  it("hands out the key with the workspace defaults for deploys", async () => {
    const { service } = setup();
    await service.save("user1", KEY);
    await service.setPreferences("user1", { region: "frankfurt", plan: "starter" });
    await expect(service.getKey("user1")).resolves.toEqual({
      apiKey: KEY,
      ownerId: "usr_1",
      region: "frankfurt",
      plan: "starter",
    });
  });

  it("reports missing, and refuses a key Render rejected until it is saved again", async () => {
    const { service } = setup();
    await expect(service.getKey("nobody")).rejects.toMatchObject({ code: "render_not_connected", status: 412 });

    await service.save("user1", KEY);
    await service.markInvalid("user1");
    await expect(service.get("user1")).resolves.toMatchObject({ state: "invalid" });
    await expect(service.getKey("user1")).rejects.toMatchObject({ code: "render_key_invalid" });

    await service.save("user1", KEY);
    await expect(service.get("user1")).resolves.toMatchObject({ state: "connected" });
  });

  it("switches workspace only to one the key can see, and only before services exist", async () => {
    const { db, service } = setup();
    await service.save("user1", KEY);

    await expect(service.setPreferences("user1", { ownerId: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(service.setPreferences("user1", { ownerId: "tea_1" })).resolves.toMatchObject({
      ownerId: "tea_1",
      ownerName: "Club",
    });

    await db.renderService.create({
      data: {
        componentId: "c1",
        userId: "user1",
        renderServiceId: "srv-1",
        name: "x",
        ownerId: "tea_1",
        region: "oregon",
        plan: "free",
        runtime: "node",
        settingsHash: "h",
      },
    });
    await expect(service.setPreferences("user1", { ownerId: "usr_1" })).rejects.toMatchObject({ status: 409 });
    // Region and plan stay changeable: they only apply to services created later.
    await expect(service.setPreferences("user1", { plan: "starter" })).resolves.toMatchObject({
      plan: "starter",
      scopeLocked: true,
    });
  });

  it("keeps the workspace on a key rotation, and blocks a key that cannot see existing services", async () => {
    const { db, service, validate } = setup();
    await service.save("user1", KEY);
    await service.setPreferences("user1", { ownerId: "tea_1" });
    await service.save("user1", `${KEY}-rotated`);
    await expect(service.get("user1")).resolves.toMatchObject({ ownerId: "tea_1" });

    await db.renderService.create({
      data: {
        componentId: "c1",
        userId: "user1",
        renderServiceId: "srv-1",
        name: "x",
        ownerId: "tea_1",
        region: "oregon",
        plan: "free",
        runtime: "node",
        settingsHash: "h",
      },
    });
    validate.mockResolvedValueOnce(account({ owners: [{ id: "usr_9", name: "other", type: "user" }] }));
    await expect(service.save("user1", "other_key_123456")).rejects.toMatchObject({ status: 409 });
  });

  it("disconnects", async () => {
    const { service } = setup();
    await service.save("user1", KEY);
    await expect(service.remove("user1")).resolves.toEqual({ deleted: true });
    await expect(service.get("user1")).resolves.toMatchObject({ state: "missing" });
  });
});

describe("parsePreferencesInput", () => {
  it("accepts known regions and plans, and nothing else", () => {
    expect(parsePreferencesInput({ region: "singapore", plan: "free" })).toEqual({ region: "singapore", plan: "free" });
    expect(() => parsePreferencesInput({ region: "mars" })).toThrow(/region/);
    expect(() => parsePreferencesInput({ plan: "pro-max" })).toThrow(/plan/);
    expect(() => parsePreferencesInput({ teamId: "x" })).toThrow(/Unknown field/);
    expect(() => parsePreferencesInput({})).toThrow(/at least one/);
  });
});
