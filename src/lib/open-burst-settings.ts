import { ensureTradingSchema, prisma } from "./db";
import type { OpenBurstOnTrigger } from "./market-hours";
import { normalizeOpenBurstOnTrigger } from "./market-hours";

/** Works before/without prisma generate for new open-burst columns. */
export async function loadOpenBurstSettings(accountId: string): Promise<{
  skipOpenBurstEntries: boolean;
  openBurstOnTrigger: OpenBurstOnTrigger;
  openBurstLastFlattenLabel: string | null;
}> {
  await ensureTradingSchema();
  const rows = await prisma.$queryRaw<
    Array<{
      skipOpenBurstEntries: boolean;
      openBurstOnTrigger: string | null;
      openBurstLastFlattenLabel: string | null;
    }>
  >`
    SELECT "skipOpenBurstEntries", "openBurstOnTrigger", "openBurstLastFlattenLabel"
    FROM "BrokerAccount"
    WHERE id = ${accountId}
    LIMIT 1
  `;
  const r = rows[0];
  return {
    skipOpenBurstEntries: !!r?.skipOpenBurstEntries,
    openBurstOnTrigger: normalizeOpenBurstOnTrigger(r?.openBurstOnTrigger),
    openBurstLastFlattenLabel: r?.openBurstLastFlattenLabel ?? null,
  };
}

export async function saveOpenBurstSettings(
  accountId: string,
  patch: {
    skipOpenBurstEntries?: boolean;
    openBurstOnTrigger?: OpenBurstOnTrigger;
    openBurstLastFlattenLabel?: string | null;
  },
) {
  await ensureTradingSchema();
  if (patch.skipOpenBurstEntries !== undefined) {
    await prisma.$executeRaw`
      UPDATE "BrokerAccount"
      SET "skipOpenBurstEntries" = ${patch.skipOpenBurstEntries}
      WHERE id = ${accountId}
    `;
  }
  if (patch.openBurstOnTrigger !== undefined) {
    await prisma.$executeRaw`
      UPDATE "BrokerAccount"
      SET "openBurstOnTrigger" = ${patch.openBurstOnTrigger}
      WHERE id = ${accountId}
    `;
  }
  if (patch.openBurstLastFlattenLabel !== undefined) {
    await prisma.$executeRaw`
      UPDATE "BrokerAccount"
      SET "openBurstLastFlattenLabel" = ${patch.openBurstLastFlattenLabel}
      WHERE id = ${accountId}
    `;
  }
}
