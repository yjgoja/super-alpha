import * as fs from "fs";
import * as path from "path";

export type FactoryBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  spread?: number;
};

const OUT = path.join(process.cwd(), "scripts", "out");

/** Load OHLC JSON written by `_fetch-m1.ts` if present. */
export function loadBarsFromDisk(symbol: string): FactoryBar[] {
  const candidates = [
    path.join(OUT, `ohlc-${symbol}-M1.json`),
    path.join(OUT, `ohlc-${symbol}-M15.json`),
    path.join(OUT, `ohlc-${symbol}.json`),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as FactoryBar[] | { bars: FactoryBar[] };
    const bars = Array.isArray(raw) ? raw : raw.bars;
    if (Array.isArray(bars) && bars.length > 10) {
      return bars
        .filter((b) => b && b.close > 0 && b.time)
        .sort((a, b) => a.time.localeCompare(b.time));
    }
  }
  return [];
}

/**
 * Deterministic synthetic FX path for offline factory when no MetaAPI OHLC.
 * Not a claim of realism — enables unattended ranking loops.
 */
export function synthesizeBars(opts: {
  symbol: string;
  seed: number;
  bars?: number;
  startMid?: number;
}): FactoryBar[] {
  const n = opts.bars ?? 60 * 24 * 90; // ~90 days M1-ish compressed as sequential minutes
  let t = opts.seed >>> 0;
  const rng = () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const start =
    opts.startMid ??
    (opts.symbol.includes("XAU") ? 2650 : opts.symbol.startsWith("GBP") ? 1.27 : 1.085);
  const vol =
    opts.symbol.includes("XAU") ? 0.00035 : opts.symbol.startsWith("GBP") ? 0.00012 : 0.0001;
  const spread =
    opts.symbol.includes("XAU") ? 0.25 : opts.symbol.startsWith("GBP") ? 0.00012 : 0.0001;

  const out: FactoryBar[] = [];
  let mid = start;
  const startMs = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < n; i++) {
    // mild regime: slow drift + noise + occasional spike
    const drift = (rng() - 0.48) * vol;
    const spike = rng() < 0.002 ? (rng() - 0.5) * vol * 8 : 0;
    const open = mid;
    mid = Math.max(mid * 0.2, mid * (1 + drift + spike));
    const high = Math.max(open, mid) * (1 + rng() * vol * 0.5);
    const low = Math.min(open, mid) * (1 - rng() * vol * 0.5);
    const time = new Date(startMs + i * 60_000).toISOString();
    out.push({
      time,
      open,
      high,
      low,
      close: mid,
      spread,
    });
  }
  return out;
}

export function getBarsForSymbol(symbol: string, synthSeed = 1): { bars: FactoryBar[]; source: string } {
  const disk = loadBarsFromDisk(symbol);
  if (disk.length) return { bars: disk, source: "disk" };
  return { bars: synthesizeBars({ symbol, seed: synthSeed + symbol.length * 17 }), source: "synthetic" };
}

/** Downsample for coarse screening. */
export function strideBars(bars: FactoryBar[], stride: number): FactoryBar[] {
  const s = Math.max(1, Math.floor(stride));
  if (s <= 1) return bars;
  const out: FactoryBar[] = [];
  for (let i = 0; i < bars.length; i += s) out.push(bars[i]!);
  return out;
}
