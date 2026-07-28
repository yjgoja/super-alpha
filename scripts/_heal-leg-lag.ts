/**
 * Reconcile DB basket legs to live MT5 positions (no force-close).
 * Usage: npx tsx --env-file=.env scripts/_heal-leg-lag.ts [accountId]
 */
import { prisma } from "../src/lib/db";
import { fetchSnapshot, symbolsMatch } from "../src/lib/metaapi";
import {
  planLegsFromLivePositions,
  shouldSoftReconcileLegLag,
} from "../src/lib/meta-engine";

const ACCOUNT_ID = process.argv[2] || "cms2ws1mp0001v0pnbvrad9jn";

async function main() {
  const a = await prisma.brokerAccount.findUnique({
    where: { id: ACCOUNT_ID },
    include: {
      baskets: {
        where: { status: "open" },
        include: { legs: { orderBy: { level: "asc" } } },
      },
    },
  });
  if (!a?.metaApiAccountId) throw new Error("account missing");
  console.log(`login=${a.login} equity=${a.equity} openBaskets=${a.baskets.length}`);

  const snap = await fetchSnapshot(a.metaApiAccountId);
  if (!snap.ok) throw new Error(`snap fail ${JSON.stringify(snap)}`);

  for (const b of a.baskets) {
    const dir = b.direction === "SELL" ? "SELL" : "BUY";
    const live = snap.positions.filter(
      (p) => symbolsMatch(p.symbol, b.symbol) && p.direction === dir,
    );
    const dbLots = b.legs.reduce((s, l) => s + l.lots, 0);
    const liveLots = live.reduce((s, p) => s + p.lots, 0);
    console.log(
      `${b.symbol} ${dir} dbLegs=${b.legs.length} live=${live.length} dbLots=${dbLots} liveLots=${liveLots}`,
    );
    if (live.length === 0) {
      console.log("  skip — empty live (use ghost heal path)");
      continue;
    }
    if (
      !shouldSoftReconcileLegLag({
        dbLegCount: b.legs.length,
        livePosCount: live.length,
        dbLots,
        liveLots,
      })
    ) {
      console.log("  skip — no material lag");
      continue;
    }
    const planned = planLegsFromLivePositions(live, dir);
    await prisma.$transaction(async (tx) => {
      await tx.basketLeg.deleteMany({ where: { basketId: b.id } });
      await tx.basketLeg.createMany({
        data: planned.map((l) => ({
          basketId: b.id,
          level: l.level,
          lots: l.lots,
          price: l.price,
        })),
      });
      await tx.basket.update({
        where: { id: b.id },
        data: {
          filledLevel: planned.length - 1,
          firstEntryPrice: planned[0]!.price,
          unrealizedPnl: live.reduce((s, p) => s + p.profit, 0),
        },
      });
      await tx.fill.create({
        data: {
          accountId: a.id,
          symbol: b.symbol,
          side: dir,
          lots: planned.reduce((s, l) => s + l.lots, 0),
          price: planned[0]!.price,
          pnl: 0,
          kind: "GUARD",
          note: `leg_lag_reconcile_manual|legs=${planned.length}`,
        },
      });
    });
    console.log(
      `  RECONCILED → L0..L${planned.length - 1}`,
      planned.map((l) => `${l.lots}@${l.price}`).join("+"),
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
