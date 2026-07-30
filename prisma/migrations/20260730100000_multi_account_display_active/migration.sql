-- Multi-account: display names + active account selection
ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "displayName" TEXT;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "activeBrokerAccountId" TEXT;

-- Backfill active account = newest broker account per user
UPDATE "User" u
SET "activeBrokerAccountId" = sub.id
FROM (
  SELECT DISTINCT ON ("userId") id, "userId"
  FROM "BrokerAccount"
  ORDER BY "userId", "createdAt" DESC
) sub
WHERE u.id = sub."userId"
  AND u."activeBrokerAccountId" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_activeBrokerAccountId_fkey'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_activeBrokerAccountId_fkey"
      FOREIGN KEY ("activeBrokerAccountId") REFERENCES "BrokerAccount"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
