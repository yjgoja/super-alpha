/**
 * Live SL audit: current positions vs configured stop-loss (ROI÷20 chart %).
 * Does NOT place or close orders.
 *
 * Run: npx tsx --env-file=.env scripts/sl-audit.ts
 */
import { prisma } from "../src/lib/db";
import { fetchSnapshot, getSymbolPrice, symbolsMatch } from "../src/lib/metaapi";
import {
  mt5UsedMargin,
  mt5ProfitPct,
  mt5FloatingRoiPct,
  roiToPricePct,
  pricePctToRoi,
  calcDca1000Defense,
  contractSizeForSymbol,
  DCA1000_DEFAULT_SL_ROI,
  DCA1000_LEVERAGE_BASE,
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
        equity: acc.equity,
        balance: acc.balance,
        floatingDb: +(acc.equity - acc.balance).toFixed(2),
        slCount: acc.slCount,
        tpCount: acc.tpCount,
        bots: acc.symbolBots.map((b) => ({
          symbol: b.symbol,
          enabled: b.enabled,
          logic: b.logic,
          direction: b.direction,
          startLots: b.startLots,
          tpRoi: b.takeProfitPct,
          slRoi: b.stopLossPct,
          slEnabled: b.stopLossEnabled,
          stopOnSl: b.stopOnSl,
          repeat: b.repeatEnabled,
          slPricePct: b.stopLossEnabled && b.stopLossPct > 0
            ? +roiToPricePct(b.stopLossPct).toFixed(4)
            : 0,
        })),
        baskets: acc.baskets.map((b) => ({
          symbol: b.symbol,
          direction: b.direction,
          filled: b.filledLevel,
          legs: b.legs.length,
          firstEntry: b.firstEntryPrice,
          uPnl: b.unrealizedPnl,
          totalLots: b.legs.reduce((s, l) => s + l.lots, 0),
        })),
      },
      null,
      2,
    ),
  );

  try {
    const fills = await prisma.fill.findMany({
      where: { accountId: acc.id, kind: { in: ["SL", "TP"] } },
      orderBy: { createdAt: "desc" },
      take: 15,
    });
    console.log(
      "recent_sl_tp",
      fills.map((f) => ({
        kind: f.kind,
        symbol: f.symbol,
        pnl: f.pnl,
        note: f.note,
        at: f.createdAt,
        lots: f.lots,
      })),
    );
  } catch (e) {
    console.log("fills_skip", e instanceof Error ? e.message : e);
  }

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
    slLeverageBase: DCA1000_LEVERAGE_BASE,
    defaultSlRoi: DCA1000_DEFAULT_SL_ROI,
  });

  for (const bot of acc.symbolBots) {
    const matched = snap.positions.filter((p) => symbolsMatch(p.symbol, bot.symbol));
    const pnl = matched.reduce((s, p) => s + p.profit, 0);
    const lots = matched.reduce((s, p) => s + p.lots, 0);
    const avg =
      lots > 0 ? matched.reduce((s, p) => s + p.lots * p.price, 0) / lots : 0;
    const direction = (bot.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";

    const quote = await getSymbolPrice(metaId, bot.symbol);
    const bid = quote?.bid ?? 0;
    const ask = quote?.ask ?? 0;
    const profitPct =
      avg > 0 && bid > 0 && ask > 0 ? mt5ProfitPct(direction, avg, bid, ask) : 0;

    const slRoi =
      bot.stopLossEnabled && bot.stopLossPct > 0
        ? bot.stopLossPct
        : bot.stopLossEnabled
          ? DCA1000_DEFAULT_SL_ROI
          : 0;
    const slPricePct = slRoi > 0 ? roiToPricePct(slRoi) : 0;
    const wouldSl = slPricePct > 0 && profitPct <= -slPricePct;
    const distPct = slPricePct > 0 ? profitPct + slPricePct : null; // negative = past SL
    const margin =
      lots > 0
        ? mt5UsedMargin({
            symbol: bot.symbol,
            lots,
            avgPrice: avg,
            brokerLeverage: lev,
          })
        : 0;
    const marginRoi = mt5FloatingRoiPct(pnl, margin);
    // $ at SL on CURRENT basket: notional * slPricePct/100
    const contract = contractSizeForSymbol(bot.symbol);
    const notional = lots * contract * avg;
    const estSlUsd =
      notional > 0 && slPricePct > 0
        ? +((notional * slPricePct) / 100).toFixed(2)
        : null;
    // SL price level from current avg
    const slPrice =
      avg > 0 && slPricePct > 0
        ? direction === "BUY"
          ? avg * (1 - slPricePct / 100)
          : avg * (1 + slPricePct / 100)
        : null;

    const defense = calcDca1000Defense({
      stopLossRoiPct: slRoi > 0 ? slRoi : DCA1000_DEFAULT_SL_ROI,
      startLots: bot.startLots || 0.01,
      symbol: bot.symbol,
    });

    const basket = acc.baskets.find((b) => symbolsMatch(b.symbol, bot.symbol));
    const fromFirstPct =
      basket && basket.firstEntryPrice > 0 && bid > 0
        ? direction === "BUY"
          ? ((basket.firstEntryPrice - bid) / basket.firstEntryPrice) * 100
          : ((ask - basket.firstEntryPrice) / basket.firstEntryPrice) * 100
        : null;

    console.log("sl_eval", {
      symbol: bot.symbol,
      enabled: bot.enabled,
      matched: matched.length,
      filledLevel: basket?.filledLevel ?? null,
      lots: +lots.toFixed(2),
      avg: avg > 0 ? +avg.toFixed(5) : 0,
      bid: bid > 0 ? +bid.toFixed(5) : 0,
      ask: ask > 0 ? +ask.toFixed(5) : 0,
      pnl: +pnl.toFixed(2),
      margin: +margin.toFixed(2),
      marginRoiPct: +marginRoi.toFixed(2),
      profitPct: +profitPct.toFixed(4),
      profitAsTableRoi_x20: +pricePctToRoi(profitPct).toFixed(2),
      slRoi,
      slEnabled: bot.stopLossEnabled,
      slPricePct: +slPricePct.toFixed(4),
      slTriggerPrice: slPrice != null ? +slPrice.toFixed(5) : null,
      wouldSl,
      distanceToSl_pricePct: distPct != null ? +distPct.toFixed(4) : null,
      adverseFromFirstEntryPct: fromFirstPct != null ? +fromFirstPct.toFixed(4) : null,
      whyNot:
        !wouldSl && lots > 0 && slPricePct > 0
          ? `need profitPct<=-${slPricePct.toFixed(2)}% (SL ROI ${slRoi}÷${DCA1000_LEVERAGE_BASE}) but now ${profitPct.toFixed(3)}% (still ${distPct?.toFixed(3)}% away)`
          : !bot.stopLossEnabled
            ? "SL disabled"
            : lots === 0
              ? "no positions"
              : undefined,
      estUsdLossAtSl_currentLots: estSlUsd,
      note_estUsd:
        "est $ = lots×contract×avg×(slPricePct/100). NOT margin×225%. SL uses chart%÷20, not broker-lev ROI.",
      stopOnSl: bot.stopOnSl,
      repeat: bot.repeatEnabled,
      onSlHit: bot.stopOnSl
        ? "close ALL symbol positions + disable bot (no reentry)"
        : "close ALL symbol positions; next tick may re-enter if bot still enabled",
      tableFullDefense_allLevels: {
        buySpotPctFromStart: defense.spotLongPct,
        sellSpotPctFromStart: defense.spotShortPct,
        tableMarginSl$: defense.tableMarginSlAmount,
        mt5CashSl$: defense.mt5CashSlAmount,
        slTriggerPricePctFromAvg: defense.slTriggerPricePct,
      },
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
