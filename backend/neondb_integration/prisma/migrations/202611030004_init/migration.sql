-- CreateTable
CREATE TABLE "NeonCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "accountName" VARCHAR(255) NOT NULL,
    "orgId" VARCHAR(255),
    "orgName" VARCHAR(255),
    "orgs" JSONB NOT NULL DEFAULT '[]',
    "regionId" VARCHAR(50) NOT NULL DEFAULT 'aws-us-west-2',
    "pgVersion" INTEGER NOT NULL DEFAULT 17,
    "invalidAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NeonCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NeonDatabase" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "neonProjectId" VARCHAR(255) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "orgId" VARCHAR(255),
    "regionId" VARCHAR(50) NOT NULL,
    "pgVersion" INTEGER NOT NULL,
    "branchId" VARCHAR(255) NOT NULL,
    "databaseName" VARCHAR(255) NOT NULL,
    "roleName" VARCHAR(255) NOT NULL,
    "host" VARCHAR(255),
    "state" VARCHAR(20) NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NeonDatabase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NeonCredential_userId_key" ON "NeonCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NeonDatabase_componentId_key" ON "NeonDatabase"("componentId");

-- CreateIndex
CREATE INDEX "NeonDatabase_userId_idx" ON "NeonDatabase"("userId");

