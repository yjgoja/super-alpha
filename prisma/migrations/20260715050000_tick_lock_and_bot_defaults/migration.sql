-- AlterTable
ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "tickLockedAt" TIMESTAMP(3);

-- Align SymbolBot defaults with app seed (existing rows unchanged)
ALTER TABLE "SymbolBot" ALTER COLUMN "logic" SET DEFAULT 'dca_1000';
ALTER TABLE "SymbolBot" ALTER COLUMN "takeProfitPct" SET DEFAULT 20;
ALTER TABLE "SymbolBot" ALTER COLUMN "stopLossPct" SET DEFAULT 225;
ALTER TABLE "SymbolBot" ALTER COLUMN "stopLossEnabled" SET DEFAULT true;
