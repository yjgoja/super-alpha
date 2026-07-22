/** Crypto 20x DCA table — sizes include leverage (same as MT5 EA). */
export const DCA_LEVELS = [
  { size: 10, profit: 10, deviation: 0 },
  { size: 20, profit: 10, deviation: 10 },
  { size: 40, profit: 10, deviation: 15 },
  { size: 80, profit: 10, deviation: 20 },
  { size: 160, profit: 10, deviation: 25 },
  { size: 320, profit: 10, deviation: 30 },
  { size: 640, profit: 10, deviation: 35 },
  { size: 1280, profit: 10, deviation: 40 },
  { size: 2560, profit: 10, deviation: 45 },
  { size: 5120, profit: 10, deviation: 50 },
] as const;

export function sizeRatio(level: number) {
  return DCA_LEVELS[level].size / DCA_LEVELS[0].size;
}

export function lotsForLevel(baseLots: number, level: number) {
  const raw = baseLots * sizeRatio(level);
  return Math.max(0.01, Math.round(raw * 100) / 100);
}

export function scaledDeviation(level: number, devScale: number) {
  return DCA_LEVELS[level].deviation * devScale;
}

export function finalStopPct(
  maxLevel: number,
  devScale: number,
  finalSlExtraPct: number,
) {
  return scaledDeviation(maxLevel, devScale) + finalSlExtraPct * devScale;
}

export function adversePercent(
  direction: "BUY" | "SELL",
  firstEntry: number,
  bid: number,
  ask: number,
) {
  if (direction === "BUY") {
    if (bid >= firstEntry) return 0;
    return ((firstEntry - bid) / firstEntry) * 100;
  }
  if (ask <= firstEntry) return 0;
  return ((ask - firstEntry) / firstEntry) * 100;
}

/** Rough demo PnL: EURUSD $10/pip/lot style; XAU ~$1 per $0.01 move per 0.01 lot scaled. */
export function estimateBasketPnl(
  symbol: string,
  direction: "BUY" | "SELL",
  legs: { lots: number; price: number }[],
  bid: number,
  ask: number,
) {
  const mark = direction === "BUY" ? bid : ask;
  let pnl = 0;
  for (const leg of legs) {
    const diff =
      direction === "BUY" ? mark - leg.price : leg.price - mark;
    if (symbol.includes("XAU") || symbol.includes("GOLD")) {
      pnl += diff * leg.lots * 100;
    } else {
      // EURUSD: 1 pip = 0.0001, ~$10 per standard lot
      pnl += (diff / 0.0001) * 10 * leg.lots;
    }
  }
  return pnl;
}

export const FIXED_MT5_SERVER = "ZeroMarkets-1" as const;

/** @deprecated use FIXED_MT5_SERVER — kept for UI list compatibility */
export const DEMO_SERVERS = [FIXED_MT5_SERVER] as const;

export const DEFAULT_SYMBOLS = ["EURUSD", "GBPUSD", "AUDUSD", "XAUUSD"] as const;
