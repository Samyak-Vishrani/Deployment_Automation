-- CreateTable
CREATE TABLE "RenderCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "accountName" VARCHAR(255) NOT NULL,
    "ownerId" VARCHAR(255) NOT NULL,
    "ownerName" VARCHAR(255) NOT NULL,
    "owners" JSONB NOT NULL DEFAULT '[]',
    "region" VARCHAR(30) NOT NULL DEFAULT 'oregon',
    "plan" VARCHAR(30) NOT NULL DEFAULT 'free',
    "invalidAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderService" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "renderServiceId" VARCHAR(255) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "ownerId" VARCHAR(255) NOT NULL,
    "region" VARCHAR(30) NOT NULL,
    "plan" VARCHAR(30) NOT NULL,
    "runtime" VARCHAR(30) NOT NULL,
    "url" TEXT,
    "dashboardUrl" TEXT,
    "settingsHash" VARCHAR(64) NOT NULL,
    "envHash" VARCHAR(64) NOT NULL DEFAULT '',
    "managedEnvKeys" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderDeployment" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "renderDeployId" VARCHAR(255),
    "url" TEXT,
    "dashboardUrl" TEXT,
    "errorMessage" TEXT,
    "lastLogAt" VARCHAR(40),
    "callbackSeq" INTEGER NOT NULL DEFAULT 0,
    "pendingEvents" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RenderDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RenderCredential_userId_key" ON "RenderCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderService_componentId_key" ON "RenderService"("componentId");

-- CreateIndex
CREATE INDEX "RenderService_userId_idx" ON "RenderService"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderDeployment_deploymentId_key" ON "RenderDeployment"("deploymentId");

-- CreateIndex
CREATE INDEX "RenderDeployment_state_idx" ON "RenderDeployment"("state");

-- CreateIndex
CREATE INDEX "RenderDeployment_componentId_createdAt_idx" ON "RenderDeployment"("componentId", "createdAt" DESC);

