-- CreateTable
CREATE TABLE "StrategyLogic" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "logicId" TEXT NOT NULL,
    "name" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategyLogic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StrategyLogic_accountId_idx" ON "StrategyLogic"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyLogic_accountId_logicId_key" ON "StrategyLogic"("accountId", "logicId");

-- AddForeignKey
ALTER TABLE "StrategyLogic" ADD CONSTRAINT "StrategyLogic_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
