import prisma from "@/lib/db/prisma";
import type { GithubProfile } from "@/lib/auth/github-oauth";

/** The user as the frontend sees it. */
export type PublicUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarInitials: string;
  avatarUrl: string | null;
  githubUsername: string | null;
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
 */
export async function upsertGithubUser(profile: GithubProfile): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const connection = await tx.gitHubConnection.findFirst({
      where: { githubUserId: profile.githubUserId },
      select: { id: true, userId: true },
    });

    if (connection) {
      await tx.gitHubConnection.update({
        where: { id: connection.id },
        data: { githubUsername: profile.login },
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
      },
    });
    return user.id;
  });
}

export async function findPublicUser(userId: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      githubConnections: { select: { githubUsername: true }, orderBy: { updatedAt: "desc" }, take: 1 },
    },
  });
  if (!user) {
    return null;
  }

  const githubUsername = user.githubConnections[0]?.githubUsername ?? null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: githubUsername ? `@${githubUsername}` : "Member",
    avatarInitials: initials(user.name),
    avatarUrl: user.avatarUrl,
    githubUsername,
  };
}
