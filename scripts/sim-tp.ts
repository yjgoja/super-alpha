/**
 * Simulate symbol-basket take-profit decisions (no live orders).
 * Proves: aggregate PnL/ROI, not per-position; mixed win/loss legs; close-all+reentry signal.
 *
 * Run: npx tsx scripts/sim-tp.ts
 */
import {
  mt5UsedMargin,
  shouldTriggerTakeProfit,
  MT5_BROKER_LEVERAGE_DEFAULT,
} from "../src/lib/dca1000";

type Leg = { lots: number; price: number; profit: number };

function evalBasket(opts: {
  name: string;
  symbol: string;
  legs: Leg[];
  tpRoiPct: number;
  expectHit: boolean;
}) {
  const lots = opts.legs.reduce((s, l) => s + l.lots, 0);
  const pnl = opts.legs.reduce((s, l) => s + l.profit, 0);
  const avg =
    lots > 0 ? opts.legs.reduce((s, l) => s + l.lots * l.price, 0) / lots : 0;
  const margin = mt5UsedMargin({
    symbol: opts.symbol,
    lots,
    avgPrice: avg,
    brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
  });
  const d = shouldTriggerTakeProfit({
    pnl,
    usedMargin: margin,
    tpRoiPct: opts.tpRoiPct,
  });

  // Per-position would wrongly TP if any single leg hits — we must NOT do that
  const anyLegAloneWouldHit = opts.legs.some((leg) => {
    const m = mt5UsedMargin({
      symbol: opts.symbol,
      lots: leg.lots,
      avgPrice: leg.price,
      brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
    });
    return shouldTriggerTakeProfit({
      pnl: leg.profit,
      usedMargin: m,
      tpRoiPct: opts.tpRoiPct,
    }).hit;
  });

  const pass = d.hit === opts.expectHit;
  console.log(
    JSON.stringify(
      {
        name: opts.name,
        lots: +lots.toFixed(2),
        pnl: +pnl.toFixed(2),
        margin: +margin.toFixed(2),
        roi: +d.floatingRoi.toFixed(2),
        tpRoi: opts.tpRoiPct,
        tpMoney: d.tpMoney,
        hit: d.hit,
        expectHit: opts.expectHit,
        anyLegAloneWouldHit,
        pass,
        // close-all + reentry is the engine action when hit
        wouldCloseAllAndReenter: d.hit,
      },
      null,
      2,
    ),
  );
  return pass;
}

let fail = 0;

// 1) Basket total above TP → hit (even if one leg is tiny)
if (
  !evalBasket({
    name: "basket_above_tp",
    symbol: "EURUSD",
    tpRoiPct: 20,
    expectHit: true,
    legs: [
      { lots: 1, price: 1.14, profit: 50 },
      { lots: 1, price: 1.13, profit: 50 },
    ],
  })
)
  fail += 1;

// 2) One leg big profit, others lose — basket below TP → no close
// EUR 2 lots @1.14 lev500 → margin ≈ 456, 20% TP ≈ $91
if (
  !evalBasket({
    name: "mixed_below_basket_tp",
    symbol: "EURUSD",
    tpRoiPct: 20,
    expectHit: false,
    legs: [
      { lots: 1, price: 1.14, profit: 80 }, // alone would be near/above its own margin TP
      { lots: 1, price: 1.14, profit: -50 },
    ],
  })
)
  fail += 1;

// 3) Same mixed but basket above → close ALL (not just winner)
if (
  !evalBasket({
    name: "mixed_above_basket_tp",
    symbol: "EURUSD",
    tpRoiPct: 20,
    expectHit: true,
    legs: [
      { lots: 1, price: 1.14, profit: 200 },
      { lots: 1, price: 1.14, profit: -50 },
    ],
  })
)
  fail += 1;

// 4) Live-scale EUR 224 lots: $2000 profit is NOT enough for ROI 20 (need ~$10k)
{
  const lots = 224;
  const avg = 1.14491;
  const margin = mt5UsedMargin({
    symbol: "EURUSD",
    lots,
    avgPrice: avg,
    brokerLeverage: 500,
  });
  const d2k = shouldTriggerTakeProfit({
    pnl: 2000,
    usedMargin: margin,
    tpRoiPct: 20,
  });
  const dAtTarget = shouldTriggerTakeProfit({
    pnl: d2k.tpMoney,
    usedMargin: margin,
    tpRoiPct: 20,
  });
  const ok = !d2k.hit && dAtTarget.hit && d2k.tpMoney > 10000;
  console.log(
    JSON.stringify(
      {
        name: "live_scale_eur_224lots_explains_2000",
        margin: +margin.toFixed(2),
        tpMoney: d2k.tpMoney,
        pnl2000_hit: d2k.hit,
        pnlAtTpMoney_hit: dAtTarget.hit,
        pass: ok,
      },
      null,
      2,
    ),
  );
  if (!ok) fail += 1;
}

// 5) XAU small basket: $2000 easily hits 20% ROI
{
  const margin = mt5UsedMargin({
    symbol: "XAUUSD",
    lots: 1,
    avgPrice: 4050,
    brokerLeverage: 500,
  });
  const d = shouldTriggerTakeProfit({ pnl: 2000, usedMargin: margin, tpRoiPct: 20 });
  // margin = 100*4050/500 = 810, tpMoney = 162
  const ok = d.hit && d.tpMoney < 200;
  console.log(
    JSON.stringify(
      {
        name: "xau_1lot_2000_hits",
        margin: +margin.toFixed(2),
        tpMoney: d.tpMoney,
        hit: d.hit,
        pass: ok,
      },
      null,
      2,
    ),
  );
  if (!ok) fail += 1;
}

// 6) Empty / zero margin → no TP
{
  const d = shouldTriggerTakeProfit({ pnl: 100, usedMargin: 0, tpRoiPct: 20 });
  const ok = !d.hit;
  console.log(JSON.stringify({ name: "zero_margin_no_tp", hit: d.hit, pass: ok }));
  if (!ok) fail += 1;
}

if (fail) {
  console.error("\nSIM TP FAILED", fail);
  process.exit(1);
}
console.log(
  "\nSIM TP ALL PASSED — basket aggregate ROI TP; $2000 on 224-lot EUR does not hit 20% ROI",
);
