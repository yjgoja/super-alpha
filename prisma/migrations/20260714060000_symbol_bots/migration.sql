-- CreateTable
CREATE TABLE IF NOT EXISTS "SymbolBot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "logic" TEXT NOT NULL DEFAULT 'dca_martingale',
    "direction" TEXT NOT NULL DEFAULT 'BUY',
    "entryCount" INTEGER NOT NULL DEFAULT 10,
    "entryMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "entryIntervalPct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "takeProfitPct" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "startLots" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "repeatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "stopLossPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stopLossEnabled" BOOLEAN NOT NULL DEFAULT false,
    "stopOnSl" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SymbolBot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SymbolBot_accountId_symbol_key" ON "SymbolBot"("accountId", "symbol");
CREATE INDEX IF NOT EXISTS "SymbolBot_accountId_enabled_idx" ON "SymbolBot"("accountId", "enabled");

ALTER TABLE "SymbolBot" DROP CONSTRAINT IF EXISTS "SymbolBot_accountId_fkey";
ALTER TABLE "SymbolBot" ADD CONSTRAINT "SymbolBot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
