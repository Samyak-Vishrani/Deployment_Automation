-- Repository analysis snapshots. Additive: every run now writes an "Analysis"
-- row pinned to a commit, and its components point back at it. Component rows
-- written before this migration keep "analysisId" NULL and need no backfill.

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('running', 'succeeded', 'failed');

-- AlterTable
ALTER TABLE "ProjectComponent" ADD COLUMN     "analysisId" TEXT,
ADD COLUMN     "buildCmd" TEXT,
ADD COLUMN     "evidence" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "installCmd" TEXT,
ADD COLUMN     "outputDir" VARCHAR(500),
ADD COLUMN     "role" VARCHAR(20),
ADD COLUMN     "runtimeVersion" VARCHAR(100),
ADD COLUMN     "startCmd" TEXT;

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'running',
    "source" TEXT NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "database" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Analysis_projectId_createdAt_idx" ON "Analysis"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProjectComponent_analysisId_idx" ON "ProjectComponent"("analysisId");

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectComponent" ADD CONSTRAINT "ProjectComponent_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
