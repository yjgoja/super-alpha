-- AlterTable
ALTER TABLE "BrokerAccount" ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "syncToken" TEXT;

-- CreateIndex
CREATE INDEX "BrokerAccount_login_idx" ON "BrokerAccount"("login");
