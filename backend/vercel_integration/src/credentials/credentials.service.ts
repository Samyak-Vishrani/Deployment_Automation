import type { VercelCredential } from "@prisma/client";
import { open, seal } from "../crypto/secret-box";
import type { Db } from "../db";
import { conflict, ProviderError, badRequest } from "../http/provider-error";
import type { AccountInfo, VercelProvider } from "../vercel/vercel.provider";

export type CredentialState = "connected" | "invalid" | "missing";

/** What the main backend (and so the browser) may see. Never the token. */
export interface CredentialView {
  provider: "vercel";
  state: CredentialState;
  accountName: string | null;
  teamId: string | null;
  teamSlug: string | null;
  teams: Array<{ id: string; slug: string; name: string }>;
  /** True once a Vercel project exists in the current scope; the scope is then fixed. */
  scopeLocked: boolean;
  lastValidatedAt: string | null;
}

export interface TokenScope {
  token: string;
  teamId: string | null;
}

type Teams = CredentialView["teams"];

export class CredentialsService {
  constructor(
    private readonly db: Db,
    private readonly vercel: Pick<VercelProvider, "validateCredentials">,
  ) {}

  async get(userId: string): Promise<CredentialView> {
    const row = await this.db.vercelCredential.findUnique({ where: { userId } });
    return this.view(userId, row);
  }

  /** Validates the token with Vercel, then stores it sealed. */
  async save(userId: string, rawToken: string): Promise<CredentialView> {
    const account = await this.vercel.validateCredentials(rawToken);
    const existing = await this.db.vercelCredential.findUnique({ where: { userId } });

    // Keep the current scope when the same account re-saves (a token rotation);
    // otherwise start in the account's default team.
    const sameAccount = existing?.accountId === account.accountId;
    const teamId = sameAccount ? existing!.teamId : defaultScope(account);
    if (existing && !sameAccount && (await this.hasProjects(userId))) {
      throw conflict(
        "Vercel projects were already created with a different Vercel account. " +
          "Use a token for that account, or disconnect and remove those projects first.",
      );
    }

    const data = {
      tokenEnc: seal(rawToken),
      accountId: account.accountId,
      accountName: account.accountName,
      teamId,
      teamSlug: account.teams.find((t) => t.id === teamId)?.slug ?? null,
      teams: account.teams,
      invalidAt: null,
      lastValidatedAt: new Date(),
    };
    const row = await this.db.vercelCredential.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return this.view(userId, row);
  }

  /** Switches the Vercel scope new projects are created in. */
  async setTeam(userId: string, teamId: string | null): Promise<CredentialView> {
    const row = await this.db.vercelCredential.findUnique({ where: { userId } });
    if (!row) {
      throw new ProviderError("Connect Vercel in Settings first.", 412, "vercel_not_connected");
    }
    const teams = parseTeams(row.teams);
    if (teamId !== null && !teams.some((t) => t.id === teamId)) {
      throw badRequest("This token cannot see that Vercel team. Reconnect with a token that can.");
    }
    if (teamId !== row.teamId && (await this.hasProjects(userId))) {
      throw conflict(
        "Vercel projects already exist in the current scope, so it cannot be changed. " +
          "They would be orphaned in the old team.",
      );
    }
    const updated = await this.db.vercelCredential.update({
      where: { userId },
      data: { teamId, teamSlug: teams.find((t) => t.id === teamId)?.slug ?? null },
    });
    return this.view(userId, updated);
  }

  /** Forgets the token. Vercel projects already created are left on Vercel. */
  async remove(userId: string): Promise<{ deleted: boolean }> {
    const result = await this.db.vercelCredential.deleteMany({ where: { userId } });
    return { deleted: result.count > 0 };
  }

  /** The token to call Vercel with. Throws a user-facing error when there is none usable. */
  async getToken(userId: string): Promise<TokenScope> {
    const row = await this.db.vercelCredential.findUnique({ where: { userId } });
    if (!row) {
      throw new ProviderError("Connect Vercel in Settings first.", 412, "vercel_not_connected");
    }
    if (row.invalidAt) {
      throw new ProviderError(
        "Vercel rejected the saved token. Reconnect Vercel in Settings.",
        412,
        "vercel_token_invalid",
        { invalidToken: true },
      );
    }
    return { token: open(row.tokenEnc), teamId: row.teamId };
  }

  async markInvalid(userId: string): Promise<void> {
    await this.db.vercelCredential.updateMany({ where: { userId }, data: { invalidAt: new Date() } });
  }

  private async hasProjects(userId: string): Promise<boolean> {
    return (await this.db.vercelProject.count({ where: { userId } })) > 0;
  }

  private async view(userId: string, row: VercelCredential | null): Promise<CredentialView> {
    if (!row) {
      return {
        provider: "vercel",
        state: "missing",
        accountName: null,
        teamId: null,
        teamSlug: null,
        teams: [],
        scopeLocked: false,
        lastValidatedAt: null,
      };
    }
    return {
      provider: "vercel",
      state: row.invalidAt ? "invalid" : "connected",
      accountName: row.accountName,
      teamId: row.teamId,
      teamSlug: row.teamSlug,
      teams: parseTeams(row.teams),
      scopeLocked: await this.hasProjects(userId),
      lastValidatedAt: row.lastValidatedAt.toISOString(),
    };
  }
}

/** The default team when the token can see it, else personal scope. */
function defaultScope(account: AccountInfo): string | null {
  if (account.defaultTeamId && (account.teams.length === 0 || account.teams.some((t) => t.id === account.defaultTeamId))) {
    return account.defaultTeamId;
  }
  return null;
}

function parseTeams(value: unknown): Teams {
  return Array.isArray(value)
    ? value.filter(
        (t): t is Teams[number] =>
          !!t && typeof t === "object" && typeof (t as Teams[number]).id === "string" && typeof (t as Teams[number]).slug === "string",
      )
    : [];
}
