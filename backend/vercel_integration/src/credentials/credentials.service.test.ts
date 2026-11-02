import { describe, expect, it, vi } from "vitest";
import { open } from "../crypto/secret-box";
import { fakeDb } from "../test-support/fake-db";
import type { AccountInfo } from "../vercel/vercel.provider";
import { CredentialsService } from "./credentials.service";

const TOKEN = "vercel_token_abcdefghijklmnop";

const account = (overrides: Partial<AccountInfo> = {}): AccountInfo => ({
  accountId: "acc_1",
  accountName: "samyak",
  defaultTeamId: "team_1",
  teams: [
    { id: "team_1", slug: "samyak", name: "Samyak" },
    { id: "team_2", slug: "club", name: "Club" },
  ],
  ...overrides,
});

function setup(info = account()) {
  const db = fakeDb();
  const validate = vi.fn().mockResolvedValue(info);
  const service = new CredentialsService(db, { validateCredentials: validate });
  return { db, validate, service };
}

describe("CredentialsService", () => {
  it("stores the token sealed and never returns it", async () => {
    const { db, service } = setup();
    const view = await service.save("user1", TOKEN);

    expect(view).toMatchObject({ state: "connected", accountName: "samyak", teamId: "team_1", teamSlug: "samyak" });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    const row = db.vercelCredential.rows[0];
    expect(row.tokenEnc).not.toContain(TOKEN);
    expect(open(row.tokenEnc as string)).toBe(TOKEN);
  });

  it("reports missing before anything is saved", async () => {
    const { service } = setup();
    await expect(service.get("nobody")).resolves.toMatchObject({ state: "missing", accountName: null });
    await expect(service.getToken("nobody")).rejects.toMatchObject({ code: "vercel_not_connected", status: 412 });
  });

  it("hands out the token and scope for deploys", async () => {
    const { service } = setup();
    await service.save("user1", TOKEN);
    await expect(service.getToken("user1")).resolves.toEqual({ token: TOKEN, teamId: "team_1" });
  });

  it("refuses the token once Vercel has rejected it, until it is saved again", async () => {
    const { service } = setup();
    await service.save("user1", TOKEN);
    await service.markInvalid("user1");

    await expect(service.get("user1")).resolves.toMatchObject({ state: "invalid" });
    await expect(service.getToken("user1")).rejects.toMatchObject({ code: "vercel_token_invalid" });

    await service.save("user1", TOKEN);
    await expect(service.get("user1")).resolves.toMatchObject({ state: "connected" });
  });

  it("switches team only to one the token can see, and only before projects exist", async () => {
    const { db, service } = setup();
    await service.save("user1", TOKEN);

    await expect(service.setTeam("user1", "team_x")).rejects.toMatchObject({ status: 400 });
    await expect(service.setTeam("user1", "team_2")).resolves.toMatchObject({ teamId: "team_2", teamSlug: "club" });

    await db.vercelProject.create({
      data: { componentId: "c1", userId: "user1", vercelProjectId: "prj", name: "p", settingsHash: "h" },
    });
    await expect(service.setTeam("user1", "team_1")).rejects.toMatchObject({ status: 409 });
    await expect(service.get("user1")).resolves.toMatchObject({ scopeLocked: true });
  });

  it("keeps the scope when the same account rotates its token, and blocks a different account once projects exist", async () => {
    const { db, service, validate } = setup();
    await service.save("user1", TOKEN);
    await service.setTeam("user1", "team_2");
    await service.save("user1", `${TOKEN}-rotated`);
    await expect(service.get("user1")).resolves.toMatchObject({ teamId: "team_2" });

    await db.vercelProject.create({
      data: { componentId: "c1", userId: "user1", vercelProjectId: "prj", name: "p", settingsHash: "h" },
    });
    validate.mockResolvedValueOnce(account({ accountId: "someone_else" }));
    await expect(service.save("user1", "other_token_123456")).rejects.toMatchObject({ status: 409 });
  });

  it("disconnects", async () => {
    const { service } = setup();
    await service.save("user1", TOKEN);
    await expect(service.remove("user1")).resolves.toEqual({ deleted: true });
    await expect(service.get("user1")).resolves.toMatchObject({ state: "missing" });
  });
});
