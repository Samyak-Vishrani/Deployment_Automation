import { PrismaClient } from "@prisma/client";

/** The service's only database handle. Points at the "vercel" schema via DATABASE_URL. */
export const prisma = new PrismaClient();

export type Db = PrismaClient;
