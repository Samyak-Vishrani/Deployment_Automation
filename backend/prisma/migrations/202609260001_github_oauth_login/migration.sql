-- GitHub OAuth sign-in. Additive: the avatar is nullable and refreshed on every
-- login, so existing users need no backfill.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;
