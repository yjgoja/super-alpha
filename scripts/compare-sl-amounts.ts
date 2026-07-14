/**
 * Compare table-margin vs MT5-cash SL amounts (offline).
 * Run: npx tsx scripts/compare-sl-amounts.ts
 */
import { calcDca1000Defense, mt5TpMoneyTarget, roiToPricePct } from "../src/lib/dca1000";

for (const sym of ["EURUSD", "XAUUSD"] as const) {
  const d = calcDca1000Defense({
    symbol: sym,
    startLots: 0.01,
    stopLossRoiPct: 225,
  });
  const tp = mt5TpMoneyTarget({
    symbol: sym,
    lots: 0.01,
    avgPrice: d.refMid,
    tpRoiPct: 20,
    brokerLeverage: 500,
  });
  console.log(
    JSON.stringify(
      {
        sym,
        roiDefensePct: d.roiDefensePct,
        slTriggerPricePct: d.slTriggerPricePct,
        engineSlChartPct: roiToPricePct(225),
        tableMarginSl: d.tableMarginSlAmount,
        mt5CashSl: d.mt5CashSlAmount,
        estimatedSl: d.estimatedSlAmount,
        estimatedMatchesMt5: d.estimatedSlAmount === d.mt5CashSlAmount,
        tpL0: tp,
      },
      null,
      2,
    ),
  );
}
