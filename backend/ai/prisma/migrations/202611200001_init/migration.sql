-- CreateTable
CREATE TABLE "AiAnalysis" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "scope" VARCHAR(20) NOT NULL,
    "componentId" TEXT,
    "deploymentId" TEXT,
    "question" TEXT,
    "inputHash" VARCHAR(64) NOT NULL,
    "engine" VARCHAR(20) NOT NULL,
    "model" VARCHAR(60),
    "status" VARCHAR(20) NOT NULL,
    "result" JSONB,
    "notice" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "durationMs" INTEGER,
    "helpful" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAnalysis_userId_createdAt_idx" ON "AiAnalysis"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_projectId_createdAt_idx" ON "AiAnalysis"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_inputHash_createdAt_idx" ON "AiAnalysis"("inputHash", "createdAt");

