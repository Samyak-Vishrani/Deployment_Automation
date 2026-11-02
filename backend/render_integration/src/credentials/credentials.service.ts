import type { Prisma, RenderCredential } from "@prisma/client";
import { open, seal } from "../crypto/secret-box";
import type { Db } from "../db";
import { badRequest, conflict, ProviderError } from "../http/provider-error";
import type { AccountInfo, Owner, RenderProvider } from "../render/render.provider";
import type { ServiceDefaults } from "../render/service-settings";
import type { Preferences } from "./credential-input";

export type CredentialState = "connected" | "invalid" | "missing";

/** What the main backend (and so the browser) may see. Never the key. */
export interface CredentialView {
  provider: "render";
  state: CredentialState;
  accountName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  owners: Owner[];
  region: string | null;
  plan: string | null;
  /** True once a Render service exists; the workspace is then fixed. */
  scopeLocked: boolean;
  lastValidatedAt: string | null;
}

export interface KeyScope extends ServiceDefaults {
  apiKey: string;
}

export class CredentialsService {
  constructor(
    private readonly db: Db,
    private readonly render: Pick<RenderProvider, "validateCredentials">,
  ) {}

  async get(userId: string): Promise<CredentialView> {
    const row = await this.db.renderCredential.findUnique({ where: { userId } });
    return this.view(userId, row);
  }

  /** Validates the key with Render, then stores it sealed. */
  async save(userId: string, apiKey: string): Promise<CredentialView> {
    const account = await this.render.validateCredentials(apiKey);
    const existing = await this.db.renderCredential.findUnique({ where: { userId } });

    // A key for the same account (a rotation) keeps the chosen workspace when it
    // can still see it; anything else starts in the personal workspace.
    const keepOwner = existing && account.owners.some((o) => o.id === existing.ownerId);
    if (existing && !keepOwner && (await this.hasServices(userId))) {
      throw conflict(
        "Render services were already created in a workspace this key cannot see. " +
          "Use a key for that account, or disconnect and remove those services first.",
      );
    }
    const owner = keepOwner ? account.owners.find((o) => o.id === existing!.ownerId)! : defaultOwner(account);

    const data = {
      apiKeyEnc: seal(apiKey),
      accountName: account.accountName,
      ownerId: owner.id,
      ownerName: owner.name,
      owners: account.owners as unknown as Prisma.InputJsonValue,
      invalidAt: null,
      lastValidatedAt: new Date(),
    };
    const row = await this.db.renderCredential.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return this.view(userId, row);
  }

  /** Workspace, default region and default plan for new services. */
  async setPreferences(userId: string, prefs: Preferences): Promise<CredentialView> {
    const row = await this.db.renderCredential.findUnique({ where: { userId } });
    if (!row) {
      throw new ProviderError("Connect Render in Settings first.", 412, "render_not_connected");
    }
    const owners = parseOwners(row.owners);
    const data: Partial<Pick<RenderCredential, "ownerId" | "ownerName" | "region" | "plan">> = {};

    if (prefs.ownerId !== undefined && prefs.ownerId !== row.ownerId) {
      const owner = owners.find((o) => o.id === prefs.ownerId);
      if (!owner) {
        throw badRequest("This API key cannot see that Render workspace. Reconnect with a key that can.");
      }
      if (await this.hasServices(userId)) {
        throw conflict(
          "Render services already exist in the current workspace, so it cannot be changed. " +
            "They would be orphaned there.",
        );
      }
      data.ownerId = owner.id;
      data.ownerName = owner.name;
    }
    if (prefs.region !== undefined) data.region = prefs.region;
    if (prefs.plan !== undefined) data.plan = prefs.plan;

    const updated = await this.db.renderCredential.update({ where: { userId }, data });
    return this.view(userId, updated);
  }

  /** Forgets the key. Services already created stay on Render. */
  async remove(userId: string): Promise<{ deleted: boolean }> {
    const result = await this.db.renderCredential.deleteMany({ where: { userId } });
    return { deleted: result.count > 0 };
  }

  /** The key and defaults to call Render with. Throws a user-facing error when unusable. */
  async getKey(userId: string): Promise<KeyScope> {
    const row = await this.db.renderCredential.findUnique({ where: { userId } });
    if (!row) {
      throw new ProviderError("Connect Render in Settings first.", 412, "render_not_connected");
    }
    if (row.invalidAt) {
      throw new ProviderError(
        "Render rejected the saved API key. Reconnect Render in Settings.",
        412,
        "render_key_invalid",
        { invalidToken: true },
      );
    }
    return { apiKey: open(row.apiKeyEnc), ownerId: row.ownerId, region: row.region, plan: row.plan };
  }

  async markInvalid(userId: string): Promise<void> {
    await this.db.renderCredential.updateMany({ where: { userId }, data: { invalidAt: new Date() } });
  }

  private async hasServices(userId: string): Promise<boolean> {
    return (await this.db.renderService.count({ where: { userId } })) > 0;
  }

  private async view(userId: string, row: RenderCredential | null): Promise<CredentialView> {
    if (!row) {
      return {
        provider: "render",
        state: "missing",
        accountName: null,
        ownerId: null,
        ownerName: null,
        owners: [],
        region: null,
        plan: null,
        scopeLocked: false,
        lastValidatedAt: null,
      };
    }
    return {
      provider: "render",
      state: row.invalidAt ? "invalid" : "connected",
      accountName: row.accountName,
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      owners: parseOwners(row.owners),
      region: row.region,
      plan: row.plan,
      scopeLocked: await this.hasServices(userId),
      lastValidatedAt: row.lastValidatedAt.toISOString(),
    };
  }
}

/** The personal workspace when there is one, else the first the key can see. */
function defaultOwner(account: AccountInfo): Owner {
  return account.owners.find((o) => o.type === "user") ?? account.owners[0];
}

function parseOwners(value: unknown): Owner[] {
  return Array.isArray(value)
    ? value.filter(
        (o): o is Owner =>
          !!o && typeof o === "object" && typeof (o as Owner).id === "string" && typeof (o as Owner).name === "string",
      )
    : [];
}
