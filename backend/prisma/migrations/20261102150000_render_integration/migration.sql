-- CreateTable
CREATE TABLE "RenderConnection" (
    "userId" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderConnection_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RenderConfig" (
    "componentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "runtime" TEXT NOT NULL DEFAULT 'node',
    "region" TEXT NOT NULL DEFAULT 'singapore',
    "plan" TEXT NOT NULL DEFAULT 'free',
    "healthCheckPath" TEXT NOT NULL DEFAULT '',
    "envEnc" TEXT NOT NULL,
    "serviceId" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderConfig_pkey" PRIMARY KEY ("componentId")
);

-- CreateTable
CREATE TABLE "RenderDeployment" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitting',
    "phase" TEXT NOT NULL DEFAULT 'configure',
    "deployId" TEXT,
    "error" TEXT,
    "logs" TEXT NOT NULL DEFAULT '',
    "logWarning" TEXT,
    "secretSnapshotEnc" TEXT NOT NULL,
    "analysis" JSONB,
    "analysisError" TEXT,
    "analysisStartedAt" TIMESTAMP(3),
    "syncAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RenderDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderRateLimit" (
    "key" TEXT NOT NULL,
    "window" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "RenderRateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "RenderConfig_serviceName_key" ON "RenderConfig"("serviceName");

-- CreateIndex
CREATE UNIQUE INDEX "RenderConfig_serviceId_key" ON "RenderConfig"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderDeployment_requestKey_key" ON "RenderDeployment"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "RenderDeployment_deployId_key" ON "RenderDeployment"("deployId");

-- CreateIndex
CREATE INDEX "RenderDeployment_componentId_createdAt_idx" ON "RenderDeployment"("componentId", "createdAt" DESC);

-- A deployment intent is durable before a provider call. Prevent concurrent creates across processes.
CREATE UNIQUE INDEX "RenderDeployment_one_active_per_component" ON "RenderDeployment"("componentId")
WHERE "status" IN ('submitting', 'uncertain', 'deploying');

-- AddForeignKey
ALTER TABLE "RenderConnection" ADD CONSTRAINT "RenderConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderConfig" ADD CONSTRAINT "RenderConfig_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderDeployment" ADD CONSTRAINT "RenderDeployment_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "RenderConfig"("componentId") ON DELETE RESTRICT ON UPDATE CASCADE;
