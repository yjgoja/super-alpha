/**
 * Offline formula alignment: UI labels ↔ engine triggers.
 * Run: npx tsx scripts/sim-formulas.ts
 */
import {
  calcDca1000Defense,
  DCA1000_DEFAULT_SL_ROI,
  DCA1000_LEVERAGE_BASE,
  MT5_BROKER_LEVERAGE_DEFAULT,
  mt5DcaAdverseRoi,
  mt5TpMoneyTarget,
  mt5UsedMargin,
  roiToPricePct,
  shouldTriggerTakeProfit,
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

// 1) SL chart% = slRoi / 20
const slRoi = DCA1000_DEFAULT_SL_ROI;
const slChart = roiToPricePct(slRoi);
assert("SL chart% = 225/20 = 11.25", slChart === 11.25, { slChart });

// 2) TP money = margin@500 × ROI%
const margin = mt5UsedMargin({
  symbol: "XAUUSD",
  lots: 0.01,
  avgPrice: 4080,
  brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
});
const tpMoney = mt5TpMoneyTarget({
  symbol: "XAUUSD",
  lots: 0.01,
  avgPrice: 4080,
  tpRoiPct: 20,
  brokerLeverage: 500,
});
assert("TP margin XAU 0.01@4080 ≈ 8.16", Math.abs(margin - 8.16) < 0.02, { margin });
assert("TP $ = margin×20% ≈ 1.63", Math.abs(tpMoney - 1.63) < 0.02, { tpMoney });

const tpHit = shouldTriggerTakeProfit({ pnl: 1.63, usedMargin: margin, tpRoiPct: 20 });
assert("TP hits at margin ROI 20%", tpHit.hit === true, tpHit);

// 3) DCA adverse ROI = price% × 500
const adv = mt5DcaAdverseRoi("BUY", 4080, 4060, 4060.4, 500);
assert("DCA adverse ROI uses lev500", adv > 200 && adv < 300, { adv });

// 4) Defense: estimatedSlAmount === mt5CashSlAmount; ≠ table (legacy)
const def = calcDca1000Defense({
  symbol: "EURUSD",
  startLots: 0.01,
  stopLossRoiPct: slRoi,
});
assert(
  "estimatedSl = MT5 cash (engine)",
  def.estimatedSlAmount === def.mt5CashSlAmount,
  { est: def.estimatedSlAmount, mt5: def.mt5CashSlAmount },
);
assert(
  "estimatedSl ≠ table margin (legacy)",
  def.estimatedSlAmount !== def.tableMarginSlAmount,
  { est: def.estimatedSlAmount, table: def.tableMarginSlAmount },
);
assert(
  "slTriggerPricePct = ROI/lev20",
  Math.abs(def.slTriggerPricePct - slRoi / DCA1000_LEVERAGE_BASE) < 0.0001,
  def.slTriggerPricePct,
);
assert("방어폭 (평균) > SL chart% (after DCA)", def.roiDefensePct > slChart, {
  defense: def.roiDefensePct,
  slChart,
});

// 5) Defaults
assert("default SL ROI 225", DCA1000_DEFAULT_SL_ROI === 225);
assert("broker lev 500", MT5_BROKER_LEVERAGE_DEFAULT === 500);
assert("table lev 20", DCA1000_LEVERAGE_BASE === 20);

if (failed > 0) {
  console.error(`\nSIM FORMULAS FAILED: ${failed}`);
  process.exit(1);
}
console.log("\nSIM FORMULAS ALL PASSED — UI/engine formula alignment");
