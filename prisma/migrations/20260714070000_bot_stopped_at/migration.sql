-- AlterTable
ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "botStoppedAt" TIMESTAMP(3);

-- Backfill: bot currently off → treat as stopped now (grace 24h from migrate)
UPDATE "BrokerAccount"
SET "botStoppedAt" = COALESCE("updatedAt", NOW())
WHERE "botEnabled" = false AND "botStoppedAt" IS NULL;
