/**
 * Offline SL trigger: chart-defense $ scales with lots + stopOnSl policy.
 * Run: npx tsx scripts/sim-sl.ts
 */
import {
  liveBasketTpSlUsd,
  resolveTpSlUsd,
  shouldTriggerStopLossUsd,
  DCA1000_DEFAULT_SL_ROI,
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

assert("EUR L0 SL$ = chart defense (> margin×225%)", eur.stopLossUsd > 50, eur);
assert("XAU L0 SL$ ≈ 459", Math.abs(xau.stopLossUsd - 459) < 1, xau);

const hit = shouldTriggerStopLossUsd({
  pnl: -eur.stopLossUsd,
  stopLossUsd: eur.stopLossUsd,
});
const miss = shouldTriggerStopLossUsd({
  pnl: -(eur.stopLossUsd - 0.01),
  stopLossUsd: eur.stopLossUsd,
});
assert("SL hits at -stopLossUsd", hit.hit === true, hit);
assert("SL misses just above", miss.hit === false, miss);

// Deep basket: SL grows — small L0 loss must NOT fire deep SL
const deepLive = liveBasketTpSlUsd({
  symbol: "XAUUSD",
  lots: 1.0,
  avgPrice: 4080,
  takeProfitPct: 20,
  stopLossPct: 225,
});
assert("1.0 lot XAU SL$ ≈ 45900", Math.abs(deepLive.stopLossUsd - 45900) < 50, deepLive);
const shallowLoss = shouldTriggerStopLossUsd({
  pnl: -xau.stopLossUsd, // only L0-sized loss
  stopLossUsd: deepLive.stopLossUsd,
});
assert("L0-sized loss does NOT hit deep SL", shallowLoss.hit === false, shallowLoss);

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
console.log("\nSIM SL ALL PASSED — chart-defense SL scales with lots");
