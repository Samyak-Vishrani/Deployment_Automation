-- Deployment configuration (phase 5). Additive: one "Component" row per
-- deployable part of a project, as the user confirmed it. Kept apart from the
-- "ProjectComponent" analysis output so re-analysing never touches it.

-- CreateEnum
CREATE TYPE "ComponentKind" AS ENUM ('frontend', 'backend', 'database');

-- CreateEnum
CREATE TYPE "ProviderId" AS ENUM ('vercel', 'render', 'neon', 'local_docker');

-- CreateEnum
CREATE TYPE "ComponentStatus" AS ENUM ('draft', 'configured', 'deploying', 'live', 'failed');

-- CreateTable
CREATE TABLE "Component" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "ComponentKind" NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "rootDir" VARCHAR(500) NOT NULL DEFAULT '.',
    "framework" VARCHAR(100),
    "installCmd" VARCHAR(500),
    "buildCmd" VARCHAR(500),
    "startCmd" VARCHAR(500),
    "outputDir" VARCHAR(500),
    "nodeVersion" VARCHAR(100),
    "provider" "ProviderId" NOT NULL,
    "providerResourceId" VARCHAR(255),
    "url" TEXT,
    "status" "ComponentStatus" NOT NULL DEFAULT 'draft',
    "analysisComponentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Component_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Component_projectId_idx" ON "Component"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Component_projectId_kind_rootDir_key" ON "Component"("projectId", "kind", "rootDir");

-- AddForeignKey
ALTER TABLE "Component" ADD CONSTRAINT "Component_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

