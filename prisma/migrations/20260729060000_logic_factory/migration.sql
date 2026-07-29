-- CreateTable
CREATE TABLE "LogicFactoryRun" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "tested" INTEGER NOT NULL DEFAULT 0,
    "bestScore" DOUBLE PRECISION,
    "bestLabel" TEXT,
    "bestPayload" JSONB,
    "leaderboard" JSONB,
    "status" TEXT NOT NULL DEFAULT 'running',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogicFactoryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogicFactoryPromotion" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "payload" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogicFactoryPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LogicFactoryRun_runId_key" ON "LogicFactoryRun"("runId");

-- CreateIndex
CREATE INDEX "LogicFactoryPromotion_accountId_createdAt_idx" ON "LogicFactoryPromotion"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "LogicFactoryPromotion_score_idx" ON "LogicFactoryPromotion"("score");

-- AddForeignKey
ALTER TABLE "LogicFactoryPromotion" ADD CONSTRAINT "LogicFactoryPromotion_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
