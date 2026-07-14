/**
 * Quick launch check: settings dual-source + multi-account tick eligibility.
 * Run: npx tsx --env-file=.env scripts/launch-check.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolveStrategyForAccount } from "../src/lib/strategy-resolve";

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.count();
  const accounts = await prisma.brokerAccount.findMany({
    select: {
      id: true,
      login: true,
      userId: true,
      status: true,
      botEnabled: true,
      metaApiAccountId: true,
      tickLockedAt: true,
      symbolBots: {
        select: {
          symbol: true,
          enabled: true,
          logic: true,
          takeProfitPct: true,
          stopLossPct: true,
          startLots: true,
          repeatEnabled: true,
          stopOnSl: true,
        },
      },
      strategyLogics: { select: { logicId: true, payload: true } },
    },
  });

  const tickable = accounts.filter(
    (a) =>
      a.botEnabled &&
      a.metaApiAccountId &&
      (a.status === "connected" || a.status === "undeployed"),
  );

  const pendingUsers = await prisma.user.count({ where: { approvalStatus: "pending" } });
  const rejectedUsers = await prisma.user.count({ where: { approvalStatus: "rejected" } });

  console.log(
    JSON.stringify(
      {
        users,
        pendingUsers,
        rejectedUsers,
        accounts: accounts.length,
        tickableAccounts: tickable.length,
        tickableLogins: tickable.map((a) => a.login),
        hasTickLockColumn: accounts.every((a) => "tickLockedAt" in a),
      },
      null,
      2,
    ),
  );

  for (const a of tickable) {
    for (const b of a.symbolBots.filter((x) => x.enabled)) {
      const resolved = await resolveStrategyForAccount(a.id, b.logic, {
        startLots: b.startLots,
        entryMultiplier: 2,
      });
      const logicRow = a.strategyLogics.find((s) => s.logicId === b.logic);
      const payload = (logicRow?.payload || null) as {
        startLots?: number;
        takeProfitPct?: number;
        stopLossPct?: number;
      } | null;
      const lotsMatch =
        !payload?.startLots || Math.abs(payload.startLots - b.startLots) < 0.001;
      const tpMatch =
        !payload?.takeProfitPct ||
        Math.abs(payload.takeProfitPct - b.takeProfitPct) < 0.01;
      const slMatch =
        payload?.stopLossPct == null ||
        Math.abs(payload.stopLossPct - b.stopLossPct) < 0.01;
      console.log(
        JSON.stringify({
          login: a.login,
          symbol: b.symbol,
          logic: b.logic,
          bot: {
            tp: b.takeProfitPct,
            sl: b.stopLossPct,
            lots: b.startLots,
            repeat: b.repeatEnabled,
            stopOnSl: b.stopOnSl,
          },
          resolved: {
            lots: resolved.startLots,
            tp: resolved.takeProfitPct,
            sl: resolved.stopLossPct,
            levels: resolved.levels.length,
            hasOverride: resolved.hasOverride,
          },
          syncOk: { lotsMatch, tpMatch, slMatch },
        }),
      );
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
