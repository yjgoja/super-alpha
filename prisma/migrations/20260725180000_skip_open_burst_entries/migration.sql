-- Account toggle: block new entries for 15 minutes after major open times (KST 09:00 / 17:00 / 22:30)
ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "skipOpenBurstEntries" BOOLEAN NOT NULL DEFAULT false;
