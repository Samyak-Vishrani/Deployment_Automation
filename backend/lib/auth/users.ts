import prisma from "@/lib/db/prisma";
import type { GithubProfile, GithubTokens } from "@/lib/auth/github-oauth";
import { CLEARED_TOKEN_COLUMNS, hasUsableToken, sealTokenColumns } from "@/lib/auth/github-tokens";

/** The user as the frontend sees it. */
export type PublicUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarInitials: string;
  avatarUrl: string | null;
  githubUsername: string | null;
  /** A GitHub token is stored and usable, so the repository list can be read. */
  githubConnected: boolean;
};

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

/**
 * Finds or creates the local user for a GitHub account.
 *
 * Matched by GitHub's numeric user id first, because logins and emails can
 * both change. Only when no connection exists does it fall back to the email -
 * which is GitHub's verified primary address, so it cannot be claimed by
 * someone who merely typed it into their profile.
 *
 * The token pair is sealed and written in the same transaction, replacing any
 * earlier pair: a fresh sign-in is also how a revoked authorisation recovers.
 */
export async function upsertGithubUser(profile: GithubProfile, tokens: GithubTokens): Promise<string> {
  const tokenColumns = sealTokenColumns(tokens);
  return prisma.$transaction(async (tx) => {
    const connection = await tx.gitHubConnection.findFirst({
      where: { githubUserId: profile.githubUserId },
      select: { id: true, userId: true },
    });

    if (connection) {
      await tx.gitHubConnection.update({
        where: { id: connection.id },
        data: { githubUsername: profile.login, ...tokenColumns },
      });
      await tx.user.update({
        where: { id: connection.userId },
        data: { name: profile.name, avatarUrl: profile.avatarUrl },
      });
      return connection.userId;
    }

    const user = await tx.user.upsert({
      where: { email: profile.email },
      update: { name: profile.name, avatarUrl: profile.avatarUrl },
      create: { email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl },
      select: { id: true },
    });
    await tx.gitHubConnection.create({
      data: {
        userId: user.id,
        githubUserId: profile.githubUserId,
        githubUsername: profile.login,
        ...tokenColumns,
      },
    });
    return user.id;
  });
}

export async function findPublicUser(userId: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      githubConnections: {
        select: {
          githubUsername: true,
          accessTokenEnc: true,
          refreshTokenEnc: true,
          accessTokenExpiresAt: true,
          refreshTokenExpiresAt: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  });
  if (!user) {
    return null;
  }

  const connection = user.githubConnections[0];
  const githubUsername = connection?.githubUsername ?? null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: githubUsername ? `@${githubUsername}` : "Member",
    avatarInitials: initials(user.name),
    avatarUrl: user.avatarUrl,
    githubUsername,
    githubConnected: connection ? hasUsableToken(connection) : false,
  };
}

/**
 * Forgets the stored GitHub tokens: on sign-out (by user) and when the user
 * revokes the App on GitHub (by GitHub user id). The connection row stays, so
 * the next sign-in still finds the same account.
 */
export async function clearGithubTokens(
  where: { userId: string } | { githubUserId: string },
): Promise<number> {
  const result = await prisma.gitHubConnection.updateMany({ where, data: CLEARED_TOKEN_COLUMNS });
  return result.count;
}
