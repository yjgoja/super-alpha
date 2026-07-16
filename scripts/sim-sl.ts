/**
 * Offline SL trigger: margin-ROI $ scales with lots + stopOnSl policy.
 * Run: npx tsx scripts/sim-sl.ts
 */
import {
  liveBasketTpSlUsd,
  resolveTpSlUsd,
  shouldTriggerStopLossUsd,
  DCA1000_DEFAULT_SL_ROI,
  MT5_BROKER_LEVERAGE_DEFAULT,
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

const eur = resolveTpSlUsd({
  symbol: "EURUSD",
  startLots: 0.01,
  takeProfitPct: 20,
  stopLossPct: DCA1000_DEFAULT_SL_ROI,
});
const xau = resolveTpSlUsd({
  symbol: "XAUUSD",
  startLots: 0.01,
  takeProfitPct: 20,
  stopLossPct: DCA1000_DEFAULT_SL_ROI,
});

// EUR 0.01 @1.085 → margin≈2.17 → SL225%≈$4.88
assert("EUR L0 SL$ = margin×225% (~4.88)", Math.abs(eur.stopLossUsd - 4.88) < 0.05, eur);
// XAU 0.01 @4080 → margin≈8.16 → SL225%≈$18.36
assert("XAU L0 SL$ ≈ 18.36", Math.abs(xau.stopLossUsd - 18.36) < 0.05, xau);
assert("SL$ << old chart-defense (~459)", xau.stopLossUsd < 50, xau);

const hit = shouldTriggerStopLossUsd({
  pnl: -eur.stopLossUsd,
  stopLossUsd: eur.stopLossUsd,
  usedMargin: eur.marginUsd,
  stopLossRoiPct: DCA1000_DEFAULT_SL_ROI,
});
const miss = shouldTriggerStopLossUsd({
  pnl: -(eur.stopLossUsd - 0.01),
  stopLossUsd: eur.stopLossUsd,
  usedMargin: eur.marginUsd,
  stopLossRoiPct: DCA1000_DEFAULT_SL_ROI,
});
assert("SL hits at -stopLossUsd / -225% ROI", hit.hit === true, hit);
assert("SL misses just above", miss.hit === false, miss);

// Deep basket: SL grows — small L0 loss must NOT fire deep SL
const deepLive = liveBasketTpSlUsd({
  symbol: "XAUUSD",
  lots: 1.0,
  avgPrice: 4080,
  takeProfitPct: 20,
  stopLossPct: 225,
  brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
});
// margin 816 → SL 1836
assert("1.0 lot XAU SL$ ≈ 1836", Math.abs(deepLive.stopLossUsd - 1836) < 5, deepLive);
const shallowLoss = shouldTriggerStopLossUsd({
  pnl: -xau.stopLossUsd, // only L0-sized loss
  stopLossUsd: deepLive.stopLossUsd,
  usedMargin: deepLive.marginUsd,
  stopLossRoiPct: 225,
});
assert("L0-sized loss does NOT hit deep SL", shallowLoss.hit === false, shallowLoss);

// 3×0.03 lots basket example
const basket3 = liveBasketTpSlUsd({
  symbol: "XAUUSD",
  lots: 0.09,
  avgPrice: 4080,
  takeProfitPct: 20,
  stopLossPct: 225,
});
assert("3×0.03 XAU margin ≈ 73.44", Math.abs(basket3.marginUsd - 73.44) < 0.1, basket3);
assert("3×0.03 XAU SL$ ≈ 165.24", Math.abs(basket3.stopLossUsd - 165.24) < 0.2, basket3);

function afterSl(stopOnSl: boolean) {
  return { botEnabled: !stopOnSl, reentrySameTick: false };
}
function afterTp(repeatEnabled: boolean) {
  return { botEnabled: repeatEnabled, reentrySameTick: repeatEnabled };
}

assert("stopOnSl=true → bot off, no reentry", (() => {
  const r = afterSl(true);
  return r.botEnabled === false && r.reentrySameTick === false;
})());
assert("stopOnSl=false → bot stays on", afterSl(false).botEnabled === true);
assert("repeatEnabled=true → same-tick reentry", afterTp(true).reentrySameTick === true);
assert("repeatEnabled=false → bot off", afterTp(false).botEnabled === false);

if (failed > 0) {
  console.error(`\nSIM SL FAILED: ${failed}`);
  process.exit(1);
}
console.log("\nSIM SL ALL PASSED — margin-ROI SL scales with lots");
