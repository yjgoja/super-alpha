/**
 * Offline checks for cost + protect architecture invariants.
 * Run: npx tsx scripts/_verify-realtime-cost-arch.ts
 */
import {
  basketExitPricesFromUsd,
  clampBasketProtectForLegs,
  liveBasketTpSlUsd,
  mt5PnlForTakeProfit,
  MT5_BROKER_LEVERAGE_DEFAULT,
} from "../src/lib/dca1000";
import { IDLE_BOT_HOURS } from "../src/lib/cost-optimize";

let fail = 0;
function check(name: string, pass: boolean, detail?: string) {
  if (pass) console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    fail += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

check("idle undeploy <= 2h default", IDLE_BOT_HOURS <= 2, `hours=${IDLE_BOT_HOURS}`);

const live = liveBasketTpSlUsd({
  symbol: "XAUUSD",
  lots: 0.1,
  avgPrice: 4000,
  takeProfitPct: 20,
  stopLossPct: 225,
  brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
});
const raw = basketExitPricesFromUsd({
  symbol: "XAUUSD",
  direction: "SELL",
  avgPrice: 4000,
  lots: 0.1,
  takeProfitUsd: live.takeProfitUsd,
  stopLossUsd: live.stopLossUsd,
});
const clamped = clampBasketProtectForLegs({
  direction: "SELL",
  openPrices: [3990, 4000, 4010],
  takeProfit: raw.takeProfit,
  stopLoss: raw.stopLoss,
  point: raw.point,
  stopsLevelPoints: 10,
});
check(
  "stopsLevel clamp keeps SELL TP below minOpen",
  clamped.takeProfit != null && clamped.takeProfit < 3990,
  `tp=${clamped.takeProfit}`,
);

const split = mt5PnlForTakeProfit({
  apiProfit: 10,
  symbol: "XAUUSD",
  direction: "BUY",
  legs: [{ lots: 0.01, price: 4000 }],
  bid: 3990,
  ask: 3991,
});
check("pnlForSl <= pnl (TP max / SL min)", split.pnlForSl <= split.pnl, JSON.stringify(split));

if (fail) {
  console.error(`${fail} failed`);
  process.exit(1);
}
console.log("all ok");
