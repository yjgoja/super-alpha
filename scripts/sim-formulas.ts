/**
 * Offline formula alignment: fixed USD TP/SL from startLots margin × ROI%.
 * Run: npx tsx scripts/sim-formulas.ts
 */
import {
  calcDca1000Defense,
  DCA1000_DEFAULT_SL_ROI,
  MT5_BROKER_LEVERAGE_DEFAULT,
  resolveTpSlUsd,
  shouldTriggerDcaUsd,
  shouldTriggerStopLossUsd,
  shouldTriggerTakeProfit,
  startLotsMarginUsd,
  triggerDropUsd,
  DCA1000_LEVELS,
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

// 1) startLots margin × ROI%
const margin = startLotsMarginUsd({
  symbol: "XAUUSD",
  startLots: 0.01,
  brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
});
const usd = resolveTpSlUsd({
  symbol: "XAUUSD",
  startLots: 0.01,
  takeProfitPct: 20,
  stopLossPct: DCA1000_DEFAULT_SL_ROI,
});
assert("TP margin XAU 0.01@4080 ≈ 8.16", Math.abs(margin - 8.16) < 0.02, { margin });
assert("TP $ = margin×20% ≈ 1.63", Math.abs(usd.takeProfitUsd - 1.63) < 0.02, usd);
assert("SL $ = margin×225% ≈ 18.36", Math.abs(usd.stopLossUsd - 18.36) < 0.05, usd);

const tpHit = shouldTriggerTakeProfit({
  pnl: 1.63,
  takeProfitUsd: usd.takeProfitUsd,
  usedMargin: margin,
});
assert("TP hits at +$1.63", tpHit.hit === true, tpHit);

const slHit = shouldTriggerStopLossUsd({
  pnl: -18.36,
  stopLossUsd: usd.stopLossUsd,
});
assert("SL hits at -$18.36", slHit.hit === true, slHit);

// 2) DCA dropUsd L1 = startLots margin × 10%
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

// 3) EUR defaults
const eur = resolveTpSlUsd({
  symbol: "EURUSD",
  startLots: 0.01,
  takeProfitPct: 20,
  stopLossPct: 225,
});
assert("EUR TP$ ≈ 0.43", Math.abs(eur.takeProfitUsd - 0.43) < 0.02, eur);
assert("EUR SL$ ≈ 4.88", Math.abs(eur.stopLossUsd - 4.88) < 0.05, eur);

// 4) Defense still computable (reference cash)
const def = calcDca1000Defense({
  symbol: "EURUSD",
  startLots: 0.01,
  stopLossRoiPct: DCA1000_DEFAULT_SL_ROI,
});
assert("defense estimatedSl > 0", def.estimatedSlAmount > 0, def);

if (failed > 0) {
  console.error(`\nSIM FORMULAS FAILED: ${failed}`);
  process.exit(1);
}
console.log("\nSIM FORMULAS ALL PASSED — USD = startLotsMargin × ROI%");
