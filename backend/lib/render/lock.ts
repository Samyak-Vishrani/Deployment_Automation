import type { Prisma } from "@prisma/client";

export async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`render:${userId}`}))`;
}
