import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const bots = await prisma.symbolBot.findMany({
    include: {
      account: {
        select: {
          login: true,
          botEnabled: true,
          status: true,
          balance: true,
          equity: true,
        },
      },
    },
  });
  const logics = await prisma.strategyLogic.findMany();
  const baskets = await prisma.basket.findMany({
    where: { status: "open" },
    include: { legs: true },
  });
  const fills = await prisma.fills.findMany({
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  console.log(
    JSON.stringify(
      {
        bots: bots.map((b) => ({
          login: b.account.login,
          botEnabled: b.account.botEnabled,
          status: b.account.status,
          balance: b.account.balance,
          equity: b.account.equity,
          symbol: b.symbol,
          enabled: b.enabled,
          logic: b.logic,
          direction: b.direction,
          startLots: b.startLots,
          takeProfitPct: b.takeProfitPct,
          stopLossPct: b.stopLossPct,
          stopLossEnabled: b.stopLossEnabled,
          entryIntervalPct: b.entryIntervalPct,
          entryCount: b.entryCount,
          entryMultiplier: b.entryMultiplier,
          repeatEnabled: b.repeatEnabled,
          stopOnSl: b.stopOnSl,
        })),
        logics: logics.map((l) => ({
          accountId: l.accountId,
          logicId: l.logicId,
          name: l.name,
          payload: l.payload,
        })),
        baskets: baskets.map((b) => ({
          symbol: b.symbol,
          direction: b.direction,
          filledLevel: b.filledLevel,
          firstEntryPrice: b.firstEntryPrice,
          tradingPaused: b.tradingPaused,
          legs: b.legs,
        })),
        fills: fills.map((f) => ({
          at: f.createdAt,
          symbol: f.symbol,
          kind: f.kind,
          level: f.level,
          lots: f.lots,
          price: f.price,
          pnl: f.pnl,
          note: f.note,
        })),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
