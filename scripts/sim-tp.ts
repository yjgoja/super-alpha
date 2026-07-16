/**
 * Simulate symbol-basket take-profit with live-scaling margin ROI (no live orders).
 * Proves: BasketROI ≥ TP% (pnl ≥ margin×%) closes all; TP grows with lots.
 *
 * Run: npx tsx scripts/sim-tp.ts
 */
import {
  liveBasketTpSlUsd,
  mt5UsedMargin,
  shouldTriggerTakeProfit,
  MT5_BROKER_LEVERAGE_DEFAULT,
} from "../src/lib/dca1000";

type Leg = { lots: number; price: number; profit: number };

function evalBasket(opts: {
  name: string;
  symbol: string;
  legs: Leg[];
  takeProfitPct: number;
  expectHit: boolean;
}) {
  const lots = opts.legs.reduce((s, l) => s + l.lots, 0);
  const pnl = opts.legs.reduce((s, l) => s + l.profit, 0);
  const avg =
    lots > 0 ? opts.legs.reduce((s, l) => s + l.lots * l.price, 0) / lots : 0;
  const live = liveBasketTpSlUsd({
    symbol: opts.symbol,
    lots,
    avgPrice: avg,
    takeProfitPct: opts.takeProfitPct,
    stopLossPct: 225,
    brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
  });
  const margin = mt5UsedMargin({
    symbol: opts.symbol,
    lots,
    avgPrice: avg,
    brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
  });
  const d = shouldTriggerTakeProfit({
    pnl,
    takeProfitUsd: live.takeProfitUsd,
    usedMargin: margin,
    tpRoiPct: opts.takeProfitPct,
  });

  const pass = d.hit === opts.expectHit;
  console.log(
    JSON.stringify(
      {
        name: opts.name,
        lots: +lots.toFixed(2),
        pnl: +pnl.toFixed(2),
        takeProfitUsd: live.takeProfitUsd,
        hit: d.hit,
        expectHit: opts.expectHit,
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

// L0 EUR 0.01 @1.085 → margin≈2.17 → TP20%≈$0.43
// 1) Single leg above L0 TP → hit
if (
  !evalBasket({
    name: "l0_above_live_tp",
    symbol: "EURUSD",
    takeProfitPct: 20,
    expectHit: true,
    legs: [{ lots: 0.01, price: 1.085, profit: 0.5 }],
  })
)
  fail += 1;

// 2) Deep basket: TP target grows — $0.50 is enough for L0 but NOT for 10 lots
const deep = liveBasketTpSlUsd({
  symbol: "EURUSD",
  lots: 0.1,
  avgPrice: 1.085,
  takeProfitPct: 20,
  stopLossPct: 225,
});
if (
  !evalBasket({
    name: "deep_basket_tp_grows_miss",
    symbol: "EURUSD",
    takeProfitPct: 20,
    expectHit: false,
    legs: [
      { lots: 0.05, price: 1.085, profit: 0.25 },
      { lots: 0.05, price: 1.084, profit: 0.25 },
    ],
  })
)
  fail += 1;
console.log(
  JSON.stringify({
    name: "deep_live_tp_target",
    takeProfitUsd: deep.takeProfitUsd,
    note: "0.1 lot TP should be ~10× L0 (~$4.3)",
    pass: deep.takeProfitUsd > 4,
  }),
);
if (!(deep.takeProfitUsd > 4)) fail += 1;

// 3) Deep basket with enough pnl → hit
if (
  !evalBasket({
    name: "deep_basket_above_live_tp",
    symbol: "EURUSD",
    takeProfitPct: 20,
    expectHit: true,
    legs: [
      { lots: 0.05, price: 1.085, profit: 2.5 },
      { lots: 0.05, price: 1.084, profit: 2.5 },
    ],
  })
)
  fail += 1;

if (fail > 0) {
  console.error(`\nSIM TP FAILED: ${fail}`);
  process.exit(1);
}
console.log("\nSIM TP ALL PASSED — live basket TP scales with lots");
