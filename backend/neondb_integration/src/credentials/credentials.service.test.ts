import { describe, expect, it, vi } from "vitest";
import { open } from "../crypto/secret-box";
import { fakeDb } from "../test-support/fake-db";
import { parseKeyInput, parsePreferencesInput } from "./credential-input";
import { CredentialsService } from "./credentials.service";

const KEY = "napi_0123456789abcdefghijklmnopqrstuvwxyz";
const ONE_ORG = { accountName: "Samyak", orgs: [{ id: "org-1", name: "Personal" }] };
const TWO_ORGS = { accountName: "Samyak", orgs: [{ id: "org-1", name: "Personal" }, { id: "org-2", name: "Team" }] };

function setup(account = ONE_ORG) {
  const db = fakeDb();
  const neon = { validateKey: vi.fn(async () => account) };
  return { db, neon, service: new CredentialsService(db, neon, { regionId: "aws-eu-central-1", pgVersion: 16 }) };
}

describe("CredentialsService", () => {
  it("validates, then stores the key sealed and never returns it", async () => {
    const { db, neon, service } = setup();
    const view = await service.save("u1", KEY);

    expect(neon.validateKey).toHaveBeenCalledWith(KEY);
    const row = db.neonCredential.rows[0];
    expect(row.apiKeyEnc).not.toContain(KEY);
    expect(open(row.apiKeyEnc as string)).toBe(KEY);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view).toMatchObject({ provider: "neon", state: "connected", accountName: "Samyak", scopeLocked: false });
  });

  it("starts with the configured region and version, and the only organization", async () => {
    const { service } = setup();
    await expect(service.save("u1", KEY)).resolves.toMatchObject({
      orgId: "org-1",
      orgName: "Personal",
      regionId: "aws-eu-central-1",
      pgVersion: 16,
    });
  });

  it("leaves the organization unset when there are several", async () => {
    const { service } = setup(TWO_ORGS);
    await expect(service.save("u1", KEY)).resolves.toMatchObject({ orgId: null, orgs: TWO_ORGS.orgs });
  });

  it("changes preferences, and locks the organization once a database exists", async () => {
    const { db, service } = setup(TWO_ORGS);
    await service.save("u1", KEY);
    await expect(service.setPreferences("u1", { orgId: "org-2", regionId: "aws-us-east-2", pgVersion: 15 })).resolves.toMatchObject({
      orgId: "org-2",
      orgName: "Team",
      regionId: "aws-us-east-2",
      pgVersion: 15,
    });
    await expect(service.setPreferences("u1", { orgId: "org-9" })).rejects.toMatchObject({ status: 400 });

    await db.neonDatabase.create({ data: { componentId: "c1", userId: "u1", neonProjectId: "p1" } });
    await expect(service.setPreferences("u1", { orgId: "org-1" })).rejects.toMatchObject({ status: 409 });
    // Region and version only apply to new databases, so they stay editable.
    await expect(service.setPreferences("u1", { regionId: "aws-eu-west-2" })).resolves.toMatchObject({ scopeLocked: true });
  });

  it("refuses a key that cannot see the organization its databases live in", async () => {
    const { db, neon, service } = setup(TWO_ORGS);
    await service.save("u1", KEY);
    await service.setPreferences("u1", { orgId: "org-2" });
    await db.neonDatabase.create({ data: { componentId: "c1", userId: "u1", neonProjectId: "p1" } });
    neon.validateKey.mockResolvedValueOnce(ONE_ORG);
    await expect(service.save("u1", KEY)).rejects.toMatchObject({ status: 409 });
  });

  it("marks a key invalid, after which getKey refuses it", async () => {
    const { service } = setup();
    await service.save("u1", KEY);
    await expect(service.getKey("u1")).resolves.toEqual({ apiKey: KEY, orgId: "org-1", regionId: "aws-eu-central-1", pgVersion: 16 });
    await service.markInvalid("u1");
    await expect(service.getKey("u1")).rejects.toMatchObject({ code: "neon_key_invalid" });
    await expect(service.get("u1")).resolves.toMatchObject({ state: "invalid" });
  });

  it("answers missing and not connected", async () => {
    const { service } = setup();
    await expect(service.get("nobody")).resolves.toMatchObject({ state: "missing", orgs: [] });
    await expect(service.getKey("nobody")).rejects.toMatchObject({ code: "neon_not_connected" });
    await expect(service.setPreferences("nobody", { pgVersion: 17 })).rejects.toMatchObject({ code: "neon_not_connected" });
    await expect(service.remove("nobody")).resolves.toEqual({ deleted: false });
  });
});

describe("credential input", () => {
  it("validates the key without echoing it", () => {
    expect(parseKeyInput({ apiKey: ` ${KEY} ` })).toEqual({ apiKey: KEY });
    expect(() => parseKeyInput({ apiKey: "has space" })).toThrow(/does not look like/);
    expect(() => parseKeyInput({ apiKey: "" })).toThrow(/Paste a Neon API key/);
    expect(() => parseKeyInput({ apiKey: KEY, extra: 1 })).toThrow(/Unknown field/);
  });

  it("validates preferences", () => {
    expect(parsePreferencesInput({ orgId: null, regionId: "aws-us-west-2", pgVersion: 17 })).toEqual({
      orgId: null,
      regionId: "aws-us-west-2",
      pgVersion: 17,
    });
    expect(() => parsePreferencesInput({ regionId: "oregon" })).toThrow(/regionId must be one of/);
    expect(() => parsePreferencesInput({ pgVersion: "17" })).toThrow(/pgVersion/);
    expect(() => parsePreferencesInput({})).toThrow(/at least one/);
  });
});
