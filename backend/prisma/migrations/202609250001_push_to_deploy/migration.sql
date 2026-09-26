-- Push-to-deploy pipeline, carried over from the dokploy-style prototype.
-- Purely additive: every column added to "Project" is nullable or defaulted, so
-- rows created by the repository-analysis phase stay valid without a backfill.

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('queued', 'running', 'success', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "DeploymentTrigger" AS ENUM ('push', 'manual', 'rollback');

-- AlterTable
ALTER TABLE "Project"
    ADD COLUMN "slug" TEXT,
    ADD COLUMN "repoId" INTEGER,
    ADD COLUMN "repoFullName" TEXT,
    ADD COLUMN "owner" TEXT,
    ADD COLUMN "repo" TEXT,
    ADD COLUMN "branch" TEXT,
    ADD COLUMN "autoDeploy" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "installationId" TEXT,
    ADD COLUMN "githubHookId" INTEGER,
    ADD COLUMN "webhookSecret" TEXT,
    ADD COLUMN "callbackPath" TEXT,
    ADD COLUMN "watchPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "dockerfilePath" TEXT NOT NULL DEFAULT 'Dockerfile',
    ADD COLUMN "buildContext" TEXT NOT NULL DEFAULT '.',
    ADD COLUMN "envVars" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "containerPort" INTEGER NOT NULL DEFAULT 3000,
    ADD COLUMN "hostPort" INTEGER,
    ADD COLUMN "containerId" TEXT,
    ADD COLUMN "currentImageTag" TEXT,
    ADD COLUMN "previousImageTag" TEXT;

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'queued',
    "trigger" "DeploymentTrigger" NOT NULL DEFAULT 'push',
    "branch" TEXT NOT NULL,
    "commitSha" TEXT,
    "commitMessage" TEXT,
    "commitAuthor" TEXT,
    "deliveryId" TEXT,
    "imageTag" TEXT,
    "errorMessage" TEXT,
    "logTail" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_hostPort_key" ON "Project"("hostPort");

-- CreateIndex
CREATE INDEX "Project_autoDeploy_repoId_branch_idx" ON "Project"("autoDeploy", "repoId", "branch");

-- CreateIndex
CREATE INDEX "Deployment_projectId_queuedAt_idx" ON "Deployment"("projectId", "queuedAt" DESC);

-- CreateIndex
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_projectId_deliveryId_key" ON "Deployment"("projectId", "deliveryId");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
