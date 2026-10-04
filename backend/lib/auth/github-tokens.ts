import type { GithubTokens } from "@/lib/auth/github-oauth";
import { seal } from "@/lib/crypto/secret-box";

/**
 * How a GitHub user token pair is written to, and cleared from, a
 * GitHubConnection row. Shared by sign-in, sign-out, the refresh path and the
 * webhook, so the four columns can never be half-cleared by one of them.
 */

export type StoredTokenColumns = {
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
};

export function sealTokenColumns(tokens: GithubTokens): StoredTokenColumns {
  return {
    accessTokenEnc: seal(tokens.accessToken),
    refreshTokenEnc: tokens.refreshToken ? seal(tokens.refreshToken) : null,
    accessTokenExpiresAt: tokens.expiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
  };
}

export const CLEARED_TOKEN_COLUMNS: StoredTokenColumns = {
  accessTokenEnc: null,
  refreshTokenEnc: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

/** A token is stored and either still valid or refreshable. */
export function hasUsableToken(row: StoredTokenColumns, now = Date.now()): boolean {
  if (!row.accessTokenEnc) {
    return false;
  }
  if (!row.accessTokenExpiresAt || row.accessTokenExpiresAt.getTime() > now) {
    return true;
  }
  return (
    Boolean(row.refreshTokenEnc) &&
    (!row.refreshTokenExpiresAt || row.refreshTokenExpiresAt.getTime() > now)
  );
}
