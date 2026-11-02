-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "componentId" TEXT,
ADD COLUMN     "inspectorUrl" TEXT,
ADD COLUMN     "provider" "ProviderId" NOT NULL DEFAULT 'local_docker',
ADD COLUMN     "providerDeploymentId" VARCHAR(255),
ADD COLUMN     "providerEventSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "providerStatus" VARCHAR(20),
ADD COLUMN     "sourceMode" VARCHAR(10),
ADD COLUMN     "url" TEXT;

-- CreateIndex
CREATE INDEX "Deployment_componentId_queuedAt_idx" ON "Deployment"("componentId", "queuedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_provider_providerDeploymentId_key" ON "Deployment"("provider", "providerDeploymentId");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE SET NULL ON UPDATE CASCADE;

