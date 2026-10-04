-- GitHub user tokens, sealed at rest. The plaintext "accessToken" column was
-- never written (sign-in dropped the token), so dropping it loses nothing.
-- Existing users get their tokens on their next sign-in.

-- AlterTable
ALTER TABLE "GitHubConnection" DROP COLUMN "accessToken",
ADD COLUMN     "accessTokenEnc" TEXT,
ADD COLUMN     "accessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "refreshTokenEnc" TEXT,
ADD COLUMN     "refreshTokenExpiresAt" TIMESTAMP(3);
