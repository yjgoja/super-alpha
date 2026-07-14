-- Backfill: existing members stay usable after restoring approval gate
UPDATE "User"
SET "approvalStatus" = 'approved'
WHERE "approvalStatus" = 'pending';

-- Unique MT5 login across users (skip if duplicates already exist — resolve manually)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "BrokerAccount" GROUP BY "login" HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "BrokerAccount_login_key" ON "BrokerAccount"("login");
  END IF;
END $$;
