/**
 * Simulate table-DCA decision for an underwater basket (no live orders).
 * Proves engine thresholds fire for the user's screenshot losses.
 */
import {
  mt5UsedMargin,
  mt5FloatingRoiPct,
  mt5DcaAdverseRoi,
  triggerDropRoi,
  DCA1000_LEVELS,
  MT5_BROKER_LEVERAGE_DEFAULT,
  lotsFromSize,
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
  const lossRoi = Math.max(0, -mt5FloatingRoiPct(pos.pnl, margin));
  const advPx = mt5DcaAdverseRoi("BUY", pos.entry, pos.bid, pos.ask, lev);
  const adverseRoi = Math.max(lossRoi, advPx);

  const orders: { level: number; dropRoi: number; lots: number }[] = [];
  let filled = 0; // currently only L0
  let actions = 0;
  const maxPerTick = 8;
  while (filled + 1 < DCA1000_LEVELS.length && actions < maxPerTick) {
    const next = filled + 1;
    const needRoi = triggerDropRoi(next, DCA1000_LEVELS);
    if (adverseRoi < needRoi) break;
    const size = DCA1000_LEVELS[next]?.size ?? 10;
    const lots = lotsFromSize(size, startLots);
    orders.push({ level: next, dropRoi: needRoi, lots });
    filled = next;
    actions += 1;
  }
  return {
    symbol: pos.symbol,
    adverseRoi: +adverseRoi.toFixed(2),
    firstNeed: triggerDropRoi(1, DCA1000_LEVELS),
    wouldEnterDca: orders.length > 0,
    ordersThisTick: orders,
    nextDropAfter:
      filled + 1 < DCA1000_LEVELS.length
        ? triggerDropRoi(filled + 1, DCA1000_LEVELS)
        : null,
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
console.log("\nSIM DCA ALL PASSED — underwater 1-lot positions would DCA immediately");
