/**
 * Offline unit check: SL/TP price math for all public logics at same basket.
 * Run: npx tsx scripts/_verify-logic-math.ts
 */
import {
  resolveLiveTakeProfitPct,
  resolveLiveStopLossPct,
  getMartin9Defense,
  getTableLevels,
  isBulkLogic,
  isMartin9Logic,
} from "../src/lib/table-logics";
import {
  liveBasketTpSlUsd,
  basketExitPricesFromUsd,
  clampBasketProtectForLegs,
  MT5_BROKER_LEVERAGE_DEFAULT,
} from "../src/lib/dca1000";

const PUBLIC = [
  "martin_9_068",
  "martin_9_091",
  "martin_9_113",
  "martin_9_35",
  "martin_9_65",
  "dubai_bruno_313",
  "roulette_9",
  "john_kelly_1006",
  "martin_9_068_time",
  "martin_9_35_time",
] as const;

function checkBasket(logic: string, symbol: string, direction: "BUY" | "SELL") {
  const lots = 0.1;
  const avgPrice = symbol.startsWith("XAU") ? 4000 : 1.1;
  const tpPct = resolveLiveTakeProfitPct(logic, 0);
  const slPct = resolveLiveStopLossPct(logic, 0);
  const live = liveBasketTpSlUsd({
    symbol,
    lots,
    avgPrice,
    takeProfitPct: tpPct,
    stopLossPct: slPct,
    brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
    brokerMarginSum: null,
  });
  const raw = basketExitPricesFromUsd({
    symbol,
    direction,
    avgPrice,
    lots,
    takeProfitUsd: live.takeProfitUsd,
    stopLossUsd: live.stopLossUsd,
  });
  const clamped = clampBasketProtectForLegs({
    direction,
    openPrices: [avgPrice],
    takeProfit: raw.takeProfit,
    stopLoss: raw.stopLoss,
    point: raw.point,
  });
  const levels = getTableLevels(logic);
  const defense = getMartin9Defense(logic);
  const ok =
    Number.isFinite(clamped.takeProfit) &&
    Number.isFinite(clamped.stopLoss) &&
    clamped.takeProfit > 0 &&
    clamped.stopLoss > 0 &&
    live.takeProfitUsd > 0 &&
    live.stopLossUsd > 0 &&
    levels.length > 0;
  // BUY: TP > avg, SL < avg; SELL inverse
  const sideOk =
    direction === "BUY"
      ? clamped.takeProfit > avgPrice && clamped.stopLoss < avgPrice
      : clamped.takeProfit < avgPrice && clamped.stopLoss > avgPrice;
  return {
    logic,
    symbol,
    direction,
    ok: ok && sideOk,
    tpPct,
    slPct,
    levels: levels.length,
    chartPct: defense?.chartPct ?? null,
    bulk: isBulkLogic(logic),
    martin: isMartin9Logic(logic),
    tpUsd: live.takeProfitUsd,
    slUsd: live.stopLossUsd,
    wantTP: clamped.takeProfit,
    wantSL: clamped.stopLoss,
  };
}

let fail = 0;
console.log("=== offline math all public logics ===");
for (const logic of PUBLIC) {
  for (const symbol of ["XAUUSD", "EURUSD"]) {
    for (const dir of ["BUY", "SELL"] as const) {
      const r = checkBasket(logic, symbol, dir);
      if (!r.ok) fail += 1;
      console.log(
        `${r.ok ? "OK" : "FAIL"} ${logic} ${symbol} ${dir} levels=${r.levels} TP%=${r.tpPct} SL%=${r.slPct} tp$${r.tpUsd} sl$${r.slUsd} TP=${r.wantTP} SL=${r.wantSL}`,
      );
    }
  }
}
console.log(fail === 0 ? "\nMATH_ALL_OK" : `\nMATH_FAILS=${fail}`);
process.exitCode = fail > 0 ? 2 : 0;
