/**
 * Simulate symbol-basket take-profit in fixed USD (no live orders).
 * Proves: basket PnL ≥ takeProfitUsd closes all; not per-leg.
 *
 * Run: npx tsx scripts/sim-tp.ts
 */
import {
  mt5UsedMargin,
  resolveTpSlUsd,
  shouldTriggerTakeProfit,
  MT5_BROKER_LEVERAGE_DEFAULT,
} from "../src/lib/dca1000";

type Leg = { lots: number; price: number; profit: number };

function evalBasket(opts: {
  name: string;
  symbol: string;
  legs: Leg[];
  takeProfitUsd: number;
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
    takeProfitUsd: opts.takeProfitUsd,
    usedMargin: margin,
  });

  const anyLegAloneWouldHit = opts.legs.some((leg) =>
    shouldTriggerTakeProfit({
      pnl: leg.profit,
      takeProfitUsd: opts.takeProfitUsd,
    }).hit,
  );

  const pass = d.hit === opts.expectHit;
  console.log(
    JSON.stringify(
      {
        name: opts.name,
        lots: +lots.toFixed(2),
        pnl: +pnl.toFixed(2),
        takeProfitUsd: opts.takeProfitUsd,
        hit: d.hit,
        expectHit: opts.expectHit,
        anyLegAloneWouldHit,
        pass,
        wouldCloseAllAndReenter: d.hit,
      },
      null,
      2,
    ),
  );
  return pass;
}

let fail = 0;

// Fixed $ from startLots 0.01 EUR @1.085 lev500 → margin≈2.17 → TP20%≈$0.43
const eurFixed = resolveTpSlUsd({
  symbol: "EURUSD",
  startLots: 0.01,
  takeProfitPct: 20,
  stopLossPct: 225,
});

// 1) Basket total above fixed TP → hit
if (
  !evalBasket({
    name: "basket_above_fixed_tp",
    symbol: "EURUSD",
    takeProfitUsd: eurFixed.takeProfitUsd,
    expectHit: true,
    legs: [
      { lots: 0.01, price: 1.085, profit: 0.5 },
      { lots: 0.01, price: 1.084, profit: 0.2 },
    ],
  })
)
  fail += 1;

// 2) Mixed legs — basket below fixed TP → no close (even if one leg alone > TP)
if (
  !evalBasket({
    name: "mixed_below_fixed_tp",
    symbol: "EURUSD",
    takeProfitUsd: eurFixed.takeProfitUsd,
    expectHit: false,
    legs: [
      { lots: 0.01, price: 1.085, profit: 0.5 },
      { lots: 0.01, price: 1.09, profit: -0.4 },
    ],
  })
)
  fail += 1;

// 3) Large lots but FIXED startLots TP — big basket profit still hits fixed $0.43
if (
  !evalBasket({
    name: "large_lots_still_uses_fixed_usd",
    symbol: "EURUSD",
    takeProfitUsd: eurFixed.takeProfitUsd,
    expectHit: true,
    legs: [{ lots: 1, price: 1.14, profit: 2 }],
  })
)
  fail += 1;

// 4) XAU startLots 0.01 → TP ≈ $1.63
const xauFixed = resolveTpSlUsd({
  symbol: "XAUUSD",
  startLots: 0.01,
  takeProfitPct: 20,
  stopLossPct: 225,
});
if (
  !evalBasket({
    name: "xau_fixed_tp",
    symbol: "XAUUSD",
    takeProfitUsd: xauFixed.takeProfitUsd,
    expectHit: true,
    legs: [{ lots: 0.01, price: 4080, profit: 1.63 }],
  })
)
  fail += 1;

if (Math.abs(xauFixed.takeProfitUsd - 1.63) > 0.02) {
  console.error("FAIL xau TP default", xauFixed);
  fail += 1;
} else {
  console.log("PASS xau default TP$ ≈ 1.63", xauFixed.takeProfitUsd);
}

if (fail > 0) {
  console.error(`\nSIM TP FAILED: ${fail}`);
  process.exit(1);
}
console.log("\nSIM TP ALL PASSED — fixed USD basket TP");
