/**
 * Live TP audit: current positions vs configured ROI TP threshold.
 * Does NOT place or close orders.
 *
 * Run: npx tsx --env-file=.env scripts/tp-audit.ts
 */
import { prisma } from "../src/lib/db";
import { fetchSnapshot, symbolsMatch } from "../src/lib/metaapi";
import {
  mt5UsedMargin,
  shouldTriggerTakeProfit,
  MT5_BROKER_LEVERAGE_DEFAULT,
} from "../src/lib/dca1000";

const META_ID = process.env.META_ACCOUNT_ID || "d967d9b1-5f96-4595-9e19-571db13cd234";
const LOGIN = process.env.MT5_LOGIN || "135065717";

async function main() {
  const acc = await prisma.brokerAccount.findFirst({
    where: { OR: [{ metaApiAccountId: META_ID }, { login: LOGIN }] },
    include: {
      symbolBots: true,
      baskets: { where: { status: "open" }, include: { legs: true } },
    },
  });
  if (!acc) {
    console.log("NO_ACCOUNT");
    return;
  }
  console.log(
    JSON.stringify(
      {
        id: acc.id,
        botEnabled: acc.botEnabled,
        status: acc.status,
        statusMessage: acc.statusMessage,
        equity: acc.equity,
        balance: acc.balance,
        floatingDb: +(acc.equity - acc.balance).toFixed(2),
        tpCount: acc.tpCount,
        bots: acc.symbolBots.map((b) => ({
          symbol: b.symbol,
          enabled: b.enabled,
          tpRoi: b.takeProfitPct,
          lots: b.startLots,
          repeat: b.repeatEnabled,
        })),
        baskets: acc.baskets.map((b) => ({
          symbol: b.symbol,
          filled: b.filledLevel,
          legs: b.legs.length,
          uPnl: b.unrealizedPnl,
          totalLots: b.legs.reduce((s, l) => s + l.lots, 0),
        })),
      },
      null,
      2,
    ),
  );

  const fills = await prisma.fill.findMany({
    where: { accountId: acc.id },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  console.log(
    "recent_fills",
    fills.map((f) => ({
      kind: f.kind,
      symbol: f.symbol,
      pnl: f.pnl,
      note: f.note,
      at: f.createdAt,
      lots: f.lots,
      level: f.level,
    })),
  );

  const metaId = acc.metaApiAccountId || META_ID;
  const snap = await fetchSnapshot(metaId);
  if (!snap.ok) {
    console.log("snap_fail", snap.message);
    return;
  }
  const lev = snap.leverage > 0 ? snap.leverage : MT5_BROKER_LEVERAGE_DEFAULT;
  console.log("snap", {
    balance: snap.balance,
    equity: snap.equity,
    floating: +(snap.equity - snap.balance).toFixed(2),
    leverage: lev,
    nPos: snap.positions.length,
  });

  for (const bot of acc.symbolBots.filter((b) => b.enabled)) {
    const matched = snap.positions.filter((p) => symbolsMatch(p.symbol, bot.symbol));
    const pnl = matched.reduce((s, p) => s + p.profit, 0);
    const lots = matched.reduce((s, p) => s + p.lots, 0);
    const avg =
      lots > 0 ? matched.reduce((s, p) => s + p.lots * p.price, 0) / lots : 0;
    const margin = mt5UsedMargin({
      symbol: bot.symbol,
      lots,
      avgPrice: avg,
      brokerLeverage: lev,
    });
    const d = shouldTriggerTakeProfit({
      pnl,
      usedMargin: margin,
      tpRoiPct: bot.takeProfitPct,
    });
    console.log("tp_eval", {
      symbol: bot.symbol,
      matched: matched.length,
      lots: +lots.toFixed(2),
      pnl: +pnl.toFixed(2),
      margin: +margin.toFixed(2),
      roi: +d.floatingRoi.toFixed(2),
      tpRoi: bot.takeProfitPct,
      tpMoney: d.tpMoney,
      wouldTp: d.hit,
      whyNot:
        !d.hit && lots > 0
          ? `need $${d.tpMoney} (ROI ${bot.takeProfitPct}%) but basket pnl=$${pnl.toFixed(0)}`
          : undefined,
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
