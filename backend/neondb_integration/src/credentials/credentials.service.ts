import { badRequest, conflict, ProviderError } from "@orbitops/integration-common/provider-error";
import type { NeonCredential, Prisma } from "@prisma/client";
import { open, seal } from "../crypto/secret-box";
import type { Db } from "../db";
import type { AccountInfo, NeonProvider } from "../neon/neon.provider";
import { DEFAULT_PG_VERSION, DEFAULT_REGION } from "../neon/regions";
import type { NeonOrg } from "../types";
import type { Preferences } from "./credential-input";

export type CredentialState = "connected" | "invalid" | "missing";

/** What the main backend (and so the browser) may see. Never the key. */
export interface CredentialView {
  provider: "neon";
  state: CredentialState;
  accountName: string | null;
  orgId: string | null;
  orgName: string | null;
  orgs: NeonOrg[];
  regionId: string | null;
  pgVersion: number | null;
  /** True once a Neon project was created; the organization is then fixed. */
  scopeLocked: boolean;
  lastValidatedAt: string | null;
}

/** The key and the defaults new projects are created with. */
export interface KeyScope {
  apiKey: string;
  orgId: string | null;
  regionId: string;
  pgVersion: number;
}

export interface CredentialDefaults {
  regionId: string;
  pgVersion: number;
}

export class CredentialsService {
  constructor(
    private readonly db: Db,
    private readonly neon: Pick<NeonProvider, "validateKey">,
    private readonly defaults: CredentialDefaults = { regionId: DEFAULT_REGION, pgVersion: DEFAULT_PG_VERSION },
  ) {}

  async get(userId: string): Promise<CredentialView> {
    const row = await this.db.neonCredential.findUnique({ where: { userId } });
    return this.view(userId, row);
  }

  /** Validates the key with Neon, then stores it sealed. */
  async save(userId: string, apiKey: string): Promise<CredentialView> {
    const account = await this.neon.validateKey(apiKey);
    const existing = await this.db.neonCredential.findUnique({ where: { userId } });

    // A key that can still see the chosen organization (a rotation) keeps it.
    let org: NeonOrg | null;
    if (existing?.orgId) {
      org = findOrg(account, existing.orgId);
      if (!org && (await this.hasDatabases(userId))) {
        throw conflict(
          "Neon databases were already created in an organization this key cannot see. " +
            "Use a key for that organization, or disconnect first.",
        );
      }
      org ??= defaultOrg(account);
    } else if (existing && (await this.hasDatabases(userId))) {
      // Its projects were made in the key's default organization; keep using that.
      org = null;
    } else {
      org = defaultOrg(account);
    }

    const data = {
      apiKeyEnc: seal(apiKey),
      accountName: account.accountName,
      orgId: org?.id ?? null,
      orgName: org?.name ?? null,
      orgs: account.orgs as unknown as Prisma.InputJsonValue,
      invalidAt: null,
      lastValidatedAt: new Date(),
    };
    const row = await this.db.neonCredential.upsert({
      where: { userId },
      create: { userId, ...data, regionId: this.defaults.regionId, pgVersion: this.defaults.pgVersion },
      update: data,
    });
    return this.view(userId, row);
  }

  /** Organization, region and Postgres version for new databases. */
  async setPreferences(userId: string, prefs: Preferences): Promise<CredentialView> {
    const row = await this.db.neonCredential.findUnique({ where: { userId } });
    if (!row) {
      throw new ProviderError("Connect Neon in Settings first.", 412, "neon_not_connected");
    }
    const data: Partial<Pick<NeonCredential, "orgId" | "orgName" | "regionId" | "pgVersion">> = {};

    if (prefs.orgId !== undefined && prefs.orgId !== row.orgId) {
      const org = prefs.orgId === null ? null : parseOrgs(row.orgs).find((o) => o.id === prefs.orgId);
      if (prefs.orgId !== null && !org) {
        throw badRequest("This API key cannot see that Neon organization. Reconnect with a key that can.");
      }
      if (await this.hasDatabases(userId)) {
        throw conflict(
          "Neon databases already exist in the current organization, so it cannot be changed. " +
            "They would be orphaned there.",
        );
      }
      data.orgId = org?.id ?? null;
      data.orgName = org?.name ?? null;
    }
    if (prefs.regionId !== undefined) data.regionId = prefs.regionId;
    if (prefs.pgVersion !== undefined) data.pgVersion = prefs.pgVersion;

    const updated = await this.db.neonCredential.update({ where: { userId }, data });
    return this.view(userId, updated);
  }

  /** Forgets the key. Projects already created stay on Neon. */
  async remove(userId: string): Promise<{ deleted: boolean }> {
    const result = await this.db.neonCredential.deleteMany({ where: { userId } });
    return { deleted: result.count > 0 };
  }

  /** The key and defaults to call Neon with. Throws a user-facing error when unusable. */
  async getKey(userId: string): Promise<KeyScope> {
    const row = await this.db.neonCredential.findUnique({ where: { userId } });
    if (!row) {
      throw new ProviderError("Connect Neon in Settings first.", 412, "neon_not_connected");
    }
    if (row.invalidAt) {
      throw new ProviderError(
        "Neon rejected the saved API key. Reconnect Neon in Settings.",
        412,
        "neon_key_invalid",
        { invalidToken: true },
      );
    }
    return { apiKey: open(row.apiKeyEnc), orgId: row.orgId, regionId: row.regionId, pgVersion: row.pgVersion };
  }

  async markInvalid(userId: string): Promise<void> {
    await this.db.neonCredential.updateMany({ where: { userId }, data: { invalidAt: new Date() } });
  }

  private async hasDatabases(userId: string): Promise<boolean> {
    return (await this.db.neonDatabase.count({ where: { userId } })) > 0;
  }

  private async view(userId: string, row: NeonCredential | null): Promise<CredentialView> {
    if (!row) {
      return {
        provider: "neon",
        state: "missing",
        accountName: null,
        orgId: null,
        orgName: null,
        orgs: [],
        regionId: null,
        pgVersion: null,
        scopeLocked: false,
        lastValidatedAt: null,
      };
    }
    return {
      provider: "neon",
      state: row.invalidAt ? "invalid" : "connected",
      accountName: row.accountName,
      orgId: row.orgId,
      orgName: row.orgName,
      orgs: parseOrgs(row.orgs),
      regionId: row.regionId,
      pgVersion: row.pgVersion,
      scopeLocked: await this.hasDatabases(userId),
      lastValidatedAt: row.lastValidatedAt.toISOString(),
    };
  }
}

/**
 * With exactly one organization (the usual personal account), use it, so
 * Neon never has to guess. With several, the user picks in Settings; until
 * then Neon uses the key's default.
 */
function defaultOrg(account: AccountInfo): NeonOrg | null {
  return account.orgs.length === 1 ? account.orgs[0] : null;
}

function findOrg(account: AccountInfo, orgId: string | null): NeonOrg | null {
  return orgId === null ? null : (account.orgs.find((o) => o.id === orgId) ?? null);
}

function parseOrgs(value: unknown): NeonOrg[] {
  return Array.isArray(value)
    ? value.filter(
        (o): o is NeonOrg =>
          !!o && typeof o === "object" && typeof (o as NeonOrg).id === "string" && typeof (o as NeonOrg).name === "string",
      )
    : [];
}
