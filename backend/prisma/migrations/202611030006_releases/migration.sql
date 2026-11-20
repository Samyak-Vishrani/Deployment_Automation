-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('running', 'success', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "releaseId" TEXT;

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'running',
    "trigger" "DeploymentTrigger" NOT NULL DEFAULT 'manual',
    "branch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "commitMessage" TEXT,
    "stage" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Release_projectId_createdAt_idx" ON "Release"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Release_status_idx" ON "Release"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Release_projectId_number_key" ON "Release"("projectId", "number");

-- CreateIndex
CREATE INDEX "Deployment_releaseId_idx" ON "Deployment"("releaseId");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

