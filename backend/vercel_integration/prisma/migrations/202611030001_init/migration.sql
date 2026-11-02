-- CreateTable
CREATE TABLE "VercelCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "accountId" VARCHAR(255) NOT NULL,
    "accountName" VARCHAR(255) NOT NULL,
    "teamId" VARCHAR(255),
    "teamSlug" VARCHAR(255),
    "teams" JSONB NOT NULL DEFAULT '[]',
    "invalidAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VercelCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VercelProject" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vercelProjectId" VARCHAR(255) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "teamId" VARCHAR(255),
    "gitLinked" BOOLEAN NOT NULL DEFAULT false,
    "settingsHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VercelProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VercelDeployment" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "vercelDeploymentId" VARCHAR(255),
    "sourceMode" VARCHAR(10),
    "url" TEXT,
    "inspectorUrl" TEXT,
    "productionUrl" TEXT,
    "errorMessage" TEXT,
    "lastEventAt" DOUBLE PRECISION,
    "callbackSeq" INTEGER NOT NULL DEFAULT 0,
    "pendingEvents" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "VercelDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VercelCredential_userId_key" ON "VercelCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VercelProject_componentId_key" ON "VercelProject"("componentId");

-- CreateIndex
CREATE INDEX "VercelProject_userId_idx" ON "VercelProject"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VercelDeployment_deploymentId_key" ON "VercelDeployment"("deploymentId");

-- CreateIndex
CREATE INDEX "VercelDeployment_state_idx" ON "VercelDeployment"("state");

-- CreateIndex
CREATE INDEX "VercelDeployment_componentId_createdAt_idx" ON "VercelDeployment"("componentId", "createdAt" DESC);

