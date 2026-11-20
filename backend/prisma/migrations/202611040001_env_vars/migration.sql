-- AlterTable
ALTER TABLE "Component" ADD COLUMN     "envRevision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "envRevision" INTEGER;

-- CreateTable
CREATE TABLE "EnvVar" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "componentId" TEXT,
    "key" VARCHAR(255) NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvVar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnvVar_projectId_idx" ON "EnvVar"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvVar_projectId_componentId_key_key" ON "EnvVar"("projectId", "componentId", "key");

-- AddForeignKey
ALTER TABLE "EnvVar" ADD CONSTRAINT "EnvVar_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvVar" ADD CONSTRAINT "EnvVar_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Shared rows (componentId NULL): Postgres treats NULLs as distinct, so the
-- unique index above does not stop two shared rows with the same key. Prisma
-- cannot express a partial index; schema.prisma's EnvVar comment points here.
CREATE UNIQUE INDEX "EnvVar_shared_key" ON "EnvVar"("projectId", "key") WHERE "componentId" IS NULL;
