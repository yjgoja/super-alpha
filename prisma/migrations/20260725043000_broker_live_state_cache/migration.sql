-- Shared live snapshot for UI (engine writes; web reads instead of MetaAPI)
ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "liveState" JSONB;
ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "liveStateAt" TIMESTAMP(3);
