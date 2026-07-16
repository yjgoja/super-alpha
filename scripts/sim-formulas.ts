/**
 * Offline formula alignment: live basket TP/SL (scales with lots).
 * TP = margin × TP% · SL = notional × (SL%/표레버)
 * Run: npx tsx scripts/sim-formulas.ts
 */
import {
  calcDca1000Defense,
  chartDefenseSlUsd,
  DCA1000_DEFAULT_SL_ROI,
  DCA1000_LEVELS,
  liveBasketTpSlUsd,
  MT5_BROKER_LEVERAGE_DEFAULT,
  resolveTpSlUsd,
  shouldTriggerDcaUsd,
  shouldTriggerStopLossUsd,
  shouldTriggerTakeProfit,
  startLotsMarginUsd,
  triggerDropUsd,
} from "../src/lib/dca1000";

let failed = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`, detail ?? "");
  }
}

// 1) L0 XAU: TP = margin×20%, SL = chart defense (not margin×225%)
const margin = startLotsMarginUsd({
  symbol: "XAUUSD",
  startLots: 0.01,
  brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
});
const l0 = resolveTpSlUsd({
  symbol: "XAUUSD",
  startLots: 0.01,
  takeProfitPct: 20,
  stopLossPct: DCA1000_DEFAULT_SL_ROI,
});
assert("TP margin XAU 0.01@4080 ≈ 8.16", Math.abs(margin - 8.16) < 0.02, { margin });
assert("L0 TP $ = margin×20% ≈ 1.63", Math.abs(l0.takeProfitUsd - 1.63) < 0.02, l0);
// notional 4080 × 11.25% = 459
assert("L0 SL $ = chart defense ≈ 459", Math.abs(l0.stopLossUsd - 459) < 1, l0);
assert(
  "chartDefenseSlUsd matches",
  Math.abs(
    chartDefenseSlUsd({
      symbol: "XAUUSD",
      lots: 0.01,
      avgPrice: 4080,
      stopLossPct: 225,
    }) - l0.stopLossUsd,
  ) < 0.01,
);

const tpHit = shouldTriggerTakeProfit({
  pnl: 1.63,
  takeProfitUsd: l0.takeProfitUsd,
  usedMargin: margin,
});
assert("TP hits at +$1.63", tpHit.hit === true, tpHit);

const slHit = shouldTriggerStopLossUsd({
  pnl: -l0.stopLossUsd,
  stopLossUsd: l0.stopLossUsd,
});
assert("SL hits at -chartDefense$", slHit.hit === true, slHit);

// 2) Live scales with lots (10× basket)
const live10 = liveBasketTpSlUsd({
  symbol: "XAUUSD",
  lots: 0.1,
  avgPrice: 4080,
  takeProfitPct: 20,
  stopLossPct: 225,
});
assert("10× lots → TP ≈ 16.3", Math.abs(live10.takeProfitUsd - 16.32) < 0.1, live10);
assert("10× lots → SL ≈ 4590", Math.abs(live10.stopLossUsd - 4590) < 5, live10);

// 3) DCA dropUsd L1 = startLots margin × 10%
const drop1 = triggerDropUsd({
  levelIndex: 1,
  levels: DCA1000_LEVELS,
  symbol: "XAUUSD",
  lotsAtLevel: 0.01,
  avgPrice: 4080,
});
assert("L1 dropUsd ≈ 0.82", Math.abs(drop1 - 0.82) < 0.02, { drop1 });

const dca = shouldTriggerDcaUsd({
  pnl: -1,
  usedMargin: margin,
  adversePct: 0.5,
  brokerLeverage: 500,
  needUsd: drop1,
});
assert("DCA fires when adverse$ ≥ dropUsd", dca.hit === true, dca);

// 4) EUR L0
const eur = resolveTpSlUsd({
  symbol: "EURUSD",
  startLots: 0.01,
  takeProfitPct: 20,
  stopLossPct: 225,
});
assert("EUR TP$ ≈ 0.43", Math.abs(eur.takeProfitUsd - 0.43) < 0.02, eur);
// notional ≈ 1085 × 11.25% ≈ 122
assert("EUR SL$ chart ≈ 122", Math.abs(eur.stopLossUsd - 122) < 2, eur);

// 5) Defense still computable (full ladder cash)
const def = calcDca1000Defense({
  symbol: "EURUSD",
  startLots: 0.01,
  stopLossRoiPct: DCA1000_DEFAULT_SL_ROI,
});
assert("defense estimatedSl > L0 SL", def.estimatedSlAmount > eur.stopLossUsd, def);

if (failed > 0) {
  console.error(`\nSIM FORMULAS FAILED: ${failed}`);
  process.exit(1);
}
console.log("\nSIM FORMULAS ALL PASSED — live TP=margin×% · SL=chartDefense");
