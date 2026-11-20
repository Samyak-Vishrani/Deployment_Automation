-- AlterTable
ALTER TABLE "VercelProject" ADD COLUMN     "envHash" VARCHAR(64),
ADD COLUMN     "managedEnvKeys" JSONB NOT NULL DEFAULT '[]';

