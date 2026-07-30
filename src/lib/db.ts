import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  saSchemaReady?: Promise<void>;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Self-heal critical columns when migrate deploy lagged behind a release.
 * Safe / idempotent (IF NOT EXISTS).
 */
export function ensureTradingSchema() {
  if (!globalForPrisma.saSchemaReady) {
    globalForPrisma.saSchemaReady = (async () => {
      try {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "skipOpenBurstEntries" BOOLEAN NOT NULL DEFAULT false`,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "openBurstOnTrigger" TEXT NOT NULL DEFAULT 'hold'`,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "openBurstLastFlattenLabel" TEXT`,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "displayName" TEXT`,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "activeBrokerAccountId" TEXT`,
        );
      } catch (e) {
        console.warn(
          "[db] ensureTradingSchema skipOpenBurstEntries",
          e instanceof Error ? e.message : e,
        );
      }
      try {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "liveState" JSONB`,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "liveStateAt" TIMESTAMP(3)`,
        );
      } catch (e) {
        console.warn(
          "[db] ensureTradingSchema liveState",
          e instanceof Error ? e.message : e,
        );
      }
    })();
  }
  return globalForPrisma.saSchemaReady;
}
