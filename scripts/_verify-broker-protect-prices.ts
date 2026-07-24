/**
 * 바스켓 TP$/SL$ ↔ 브로커 지정가 왕복 검증 (오프라인).
 * Run: npx tsx scripts/_verify-broker-protect-prices.ts
 */
import {
  basketExitPricesFromUsd,
  brokerProtectionMatches,
  contractSizeForSymbol,
  liveBasketTpSlUsd,
  mt5UnrealizedMoney,
  MT5_BROKER_LEVERAGE_DEFAULT,
} from "../src/lib/dca1000";

let fail = 0;

function check(name: string, pass: boolean, detail?: string) {
  if (pass) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function roundTrip(opts: {
  name: string;
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  avg: number;
  takeProfitPct: number;
  stopLossPct: number;
}) {
  const live = liveBasketTpSlUsd({
    symbol: opts.symbol,
    lots: opts.lots,
    avgPrice: opts.avg,
    takeProfitPct: opts.takeProfitPct,
    stopLossPct: opts.stopLossPct,
    brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
  });
  const px = basketExitPricesFromUsd({
    symbol: opts.symbol,
    direction: opts.direction,
    avgPrice: opts.avg,
    lots: opts.lots,
    takeProfitUsd: live.takeProfitUsd,
    stopLossUsd: live.stopLossUsd,
  });
  check(`${opts.name} has TP/SL`, px.takeProfit != null && px.stopLoss != null, JSON.stringify(px));

  if (px.takeProfit == null || px.stopLoss == null) return;

  // At TP price: unrealized ≈ takeProfitUsd (exit quote = TP for both sides roughly)
  const bid = opts.direction === "BUY" ? px.takeProfit : px.takeProfit;
  const ask = opts.direction === "BUY" ? px.takeProfit : px.takeProfit;
  const pnlAtTp = mt5UnrealizedMoney({
    symbol: opts.symbol,
    direction: opts.direction,
    lots: opts.lots,
    openPrice: opts.avg,
    bid,
    ask,
  });
  const tpErr = Math.abs(pnlAtTp - live.takeProfitUsd);
  const tol = Math.max(0.05, live.takeProfitUsd * 0.02);
  check(
    `${opts.name} TP$ round-trip`,
    tpErr <= tol,
    `pnl=${pnlAtTp.toFixed(4)} target=${live.takeProfitUsd} err=${tpErr.toFixed(4)} cs=${contractSizeForSymbol(opts.symbol)}`,
  );

  const bidSl = px.stopLoss;
  const askSl = px.stopLoss;
  const pnlAtSl = mt5UnrealizedMoney({
    symbol: opts.symbol,
    direction: opts.direction,
    lots: opts.lots,
    openPrice: opts.avg,
    bid: bidSl,
    ask: askSl,
  });
  const slErr = Math.abs(pnlAtSl + live.stopLossUsd);
  const slTol = Math.max(0.05, live.stopLossUsd * 0.02);
  check(
    `${opts.name} SL$ round-trip`,
    slErr <= slTol,
    `pnl=${pnlAtSl.toFixed(4)} target=-${live.stopLossUsd} err=${slErr.toFixed(4)}`,
  );

  check(
    `${opts.name} matches self`,
    brokerProtectionMatches({
      current: px.takeProfit,
      target: px.takeProfit,
      point: px.point,
    }) &&
      brokerProtectionMatches({
        current: px.stopLoss,
        target: px.stopLoss,
        point: px.point,
      }),
  );
  check(
    `${opts.name} drift detects unset`,
    !brokerProtectionMatches({
      current: undefined,
      target: px.takeProfit,
      point: px.point,
    }),
  );
}

roundTrip({
  name: "XAU L0 SELL",
  symbol: "XAUUSD",
  direction: "SELL",
  lots: 0.01,
  avg: 3400,
  takeProfitPct: 20,
  stopLossPct: 225,
});

roundTrip({
  name: "XAU deep SELL 5.11",
  symbol: "XAUUSD",
  direction: "SELL",
  lots: 5.11,
  avg: 4034,
  takeProfitPct: 20,
  stopLossPct: 225,
});

roundTrip({
  name: "EUR L0 BUY",
  symbol: "EURUSD",
  direction: "BUY",
  lots: 0.01,
  avg: 1.085,
  takeProfitPct: 20,
  stopLossPct: 225,
});

roundTrip({
  name: "EUR martin L8 BUY",
  symbol: "EURUSD",
  direction: "BUY",
  lots: 2.56,
  avg: 1.09,
  takeProfitPct: 20,
  stopLossPct: 225,
});

if (fail > 0) {
  console.error(`\n${fail} failed`);
  process.exit(1);
}
console.log("\nall ok");
