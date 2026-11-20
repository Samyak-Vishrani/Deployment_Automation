-- AlterTable
ALTER TABLE "VercelProject" ADD COLUMN     "managedUserEnvKeys" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "userEnvHash" VARCHAR(64);

