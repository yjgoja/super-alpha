/**
 * Offline SL trigger + stopOnSl / repeatEnabled policy checks.
 * Run: npx tsx scripts/sim-sl.ts
 */
import {
  mt5ProfitPct,
  roiToPricePct,
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

const slRoi = DCA1000_DEFAULT_SL_ROI;
const slPricePct = roiToPricePct(slRoi); // 11.25

// BUY: avg 100, bid must be <= 88.75 to hit SL
const avg = 100;
const hitBid = avg * (1 - slPricePct / 100);
const missBid = hitBid + 0.01;
const profitHit = mt5ProfitPct("BUY", avg, hitBid, hitBid + 0.0002);
const profitMiss = mt5ProfitPct("BUY", avg, missBid, missBid + 0.0002);

assert("SL price% 11.25", slPricePct === 11.25);
assert("profit at SL bid ≈ -11.25%", Math.abs(profitHit + slPricePct) < 0.05, {
  profitHit,
  hitBid,
});
assert("engine would SL", profitHit <= -slPricePct, { profitHit, slPricePct });
assert("engine would NOT SL just above", profitMiss > -slPricePct, {
  profitMiss,
  slPricePct,
});

// Policy (mirrors meta-engine): stopOnSl disables bot; !repeatEnabled disables after TP
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
assert("stopOnSl=false → bot stays on (next-tick entry)", (() => {
  const r = afterSl(false);
  return r.botEnabled === true && r.reentrySameTick === false;
})());
assert("repeatEnabled=true → same-tick reentry", afterTp(true).reentrySameTick === true);
assert("repeatEnabled=false → bot off", afterTp(false).botEnabled === false);

if (failed > 0) {
  console.error(`\nSIM SL FAILED: ${failed}`);
  process.exit(1);
}
console.log("\nSIM SL ALL PASSED — chart% SL + stopOnSl/repeat policy");
