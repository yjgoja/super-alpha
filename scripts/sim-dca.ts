/**
 * Simulate table-DCA decision with dollar adverse thresholds.
 * Run: npx tsx scripts/sim-dca.ts
 */
import {
  mt5UsedMargin,
  shouldTriggerDcaUsd,
  triggerDropUsd,
  DCA1000_LEVELS,
  MT5_BROKER_LEVERAGE_DEFAULT,
  lotsFromSize,
  mt5DcaAdversePct,
} from "../src/lib/dca1000";

type SimPos = {
  symbol: string;
  entry: number;
  bid: number;
  ask: number;
  lots: number;
  pnl: number;
};

function simulateDca(pos: SimPos, startLots = 1) {
  const lev = MT5_BROKER_LEVERAGE_DEFAULT;
  const margin = mt5UsedMargin({
    symbol: pos.symbol,
    lots: pos.lots,
    avgPrice: pos.entry,
    brokerLeverage: lev,
  });
  const adversePct = mt5DcaAdversePct("BUY", pos.entry, pos.bid, pos.ask);

  const orders: { level: number; needUsd: number; lots: number }[] = [];
  let filled = 0;
  let actions = 0;
  const maxPerTick = 8;
  while (filled + 1 < DCA1000_LEVELS.length && actions < maxPerTick) {
    const next = filled + 1;
    const lots = lotsFromSize(DCA1000_LEVELS[next]?.size ?? 10, startLots);
    const needUsd = triggerDropUsd({
      levelIndex: next,
      levels: DCA1000_LEVELS,
      symbol: pos.symbol,
      lotsAtLevel: lots,
      avgPrice: pos.entry,
      brokerLeverage: lev,
    });
    const hit = shouldTriggerDcaUsd({
      pnl: pos.pnl,
      usedMargin: margin,
      adversePct,
      brokerLeverage: lev,
      needUsd,
    });
    if (!hit.hit) break;
    orders.push({ level: next, needUsd, lots });
    filled = next;
    actions += 1;
  }
  return {
    symbol: pos.symbol,
    adversePct: +adversePct.toFixed(4),
    firstNeedUsd: triggerDropUsd({
      levelIndex: 1,
      levels: DCA1000_LEVELS,
      symbol: pos.symbol,
      lotsAtLevel: lotsFromSize(10, startLots),
      avgPrice: pos.entry,
      brokerLeverage: lev,
    }),
    wouldEnterDca: orders.length > 0,
    ordersThisTick: orders,
  };
}

const cases: SimPos[] = [
  {
    symbol: "XAUUSD",
    entry: 4080.18,
    bid: 4060.28,
    ask: 4060.48,
    lots: 1,
    pnl: -1990,
  },
  {
    symbol: "EURUSD",
    entry: 1.14491,
    bid: 1.14288,
    ask: 1.14298,
    lots: 1,
    pnl: -203,
  },
];

let fail = 0;
for (const c of cases) {
  const r = simulateDca(c, 1);
  console.log(JSON.stringify(r, null, 2));
  if (!r.wouldEnterDca || r.ordersThisTick.length !== 8) {
    console.error("FAIL", c.symbol);
    fail += 1;
  } else {
    console.log("PASS", c.symbol, "→", r.ordersThisTick.length, "DCA legs");
  }
}

if (fail) process.exit(1);
console.log("\nSIM DCA ALL PASSED — underwater 1-lot positions DCA on $ thresholds");
