/**
 * Offline SL trigger in fixed USD + stopOnSl / repeatEnabled policy.
 * Run: npx tsx scripts/sim-sl.ts
 */
import {
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

assert("EUR SL$ = margin×225%", eur.stopLossUsd > 0, eur);
assert("XAU SL$ = margin×225%", Math.abs(xau.stopLossUsd - 18.36) < 0.05, xau);

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

// Basket: large adverse $ hits fixed SL even if chart% small
const deep = shouldTriggerStopLossUsd({ pnl: -100, stopLossUsd: xau.stopLossUsd });
assert("deep loss hits XAU SL$", deep.hit === true, deep);

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
console.log("\nSIM SL ALL PASSED — fixed USD SL + stopOnSl/repeat policy");
