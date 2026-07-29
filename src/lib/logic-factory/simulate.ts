import {
  MT5_BROKER_LEVERAGE_DEFAULT,
  mt5EntryQuote,
  mt5UnrealizedMoney,
  mt5UsedMargin,
  shouldTriggerDcaRoi,
  shouldTriggerStopLossUsd,
  shouldTriggerTakeProfit,
} from "@/lib/dca1000";
import { scaleLevelsToSeed } from "./param-search";
import type { FactoryBar } from "./bars";
import type { FactoryCandidate, FactoryLevel, MonthStat, SimMetrics } from "./types";

type Leg = { lots: number; price: number; level: number };

function monthKey(iso: string) {
  return iso.slice(0, 7);
}

function bidAsk(bar: FactoryBar): { bid: number; ask: number } {
  const mid = bar.close;
  const sp = Math.max(0, bar.spread ?? mid * 0.0001);
  return { bid: mid - sp / 2, ask: mid + sp / 2 };
}

function basketPnl(
  symbol: string,
  direction: "BUY" | "SELL",
  legs: Leg[],
  bid: number,
  ask: number,
) {
  return legs.reduce(
    (s, leg) =>
      s +
      mt5UnrealizedMoney({
        symbol,
        direction,
        lots: leg.lots,
        openPrice: leg.price,
        bid,
        ask,
      }),
    0,
  );
}

function basketMargin(symbol: string, legs: Leg[]) {
  if (!legs.length) return 0;
  const lots = legs.reduce((s, l) => s + l.lots, 0);
  const avg = legs.reduce((s, l) => s + l.lots * l.price, 0) / Math.max(1e-9, lots);
  return mt5UsedMargin({
    symbol,
    lots,
    avgPrice: avg,
    brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
  });
}

function simulateOneSide(opts: {
  symbol: string;
  direction: "BUY" | "SELL";
  levels: FactoryLevel[];
  takeProfitPct: number;
  stopLossPct: number;
  repeatEnabled: boolean;
  bars: FactoryBar[];
  seed: number;
}) {
  const levels = scaleLevelsToSeed(opts.levels, 1000, opts.seed);
  let cash = opts.seed;
  let legs: Leg[] = [];
  let nextLevel = 0;
  let tpCount = 0;
  let slCount = 0;
  let tpUsd = 0;
  let slUsd = 0;
  const equityCurve: { t: string; equity: number }[] = [];
  let allowEntry = true;

  for (const bar of opts.bars) {
    const { bid, ask } = bidAsk(bar);

    if (!legs.length) {
      if (allowEntry) {
        const px = mt5EntryQuote(opts.direction, bid, ask);
        const lots = levels[0]?.lots ?? 0.01;
        legs = [{ lots, price: px, level: 0 }];
        nextLevel = 1;
        if (!opts.repeatEnabled) allowEntry = false;
      }
      equityCurve.push({ t: bar.time, equity: cash });
      continue;
    }

    const pnl = basketPnl(opts.symbol, opts.direction, legs, bid, ask);
    const margin = basketMargin(opts.symbol, legs);

    const tp = shouldTriggerTakeProfit({
      pnl,
      takeProfitUsd: 0,
      usedMargin: margin,
      tpRoiPct: opts.takeProfitPct,
    });
    if (tp.hit) {
      cash += pnl;
      tpCount += 1;
      tpUsd += Math.max(0, pnl);
      legs = [];
      nextLevel = 0;
      allowEntry = opts.repeatEnabled;
      equityCurve.push({ t: bar.time, equity: cash });
      continue;
    }

    const sl = shouldTriggerStopLossUsd({
      pnl,
      stopLossUsd: 0,
      usedMargin: margin,
      stopLossRoiPct: opts.stopLossPct,
    });
    if (sl.hit) {
      cash += pnl;
      slCount += 1;
      slUsd += Math.max(0, -pnl);
      legs = [];
      nextLevel = 0;
      allowEntry = false;
      equityCurve.push({ t: bar.time, equity: cash });
      continue;
    }

    if (nextLevel < levels.length) {
      const drop = levels[nextLevel]?.drop ?? 0;
      const dca = shouldTriggerDcaRoi({ pnl, usedMargin: margin, dropRoiPct: drop });
      if (dca.hit) {
        const px = mt5EntryQuote(opts.direction, bid, ask);
        legs.push({ lots: levels[nextLevel]!.lots, price: px, level: nextLevel });
        nextLevel += 1;
      }
    }

    equityCurve.push({
      t: bar.time,
      equity: cash + basketPnl(opts.symbol, opts.direction, legs, bid, ask),
    });
  }

  if (legs.length && opts.bars.length) {
    const last = opts.bars[opts.bars.length - 1]!;
    const { bid, ask } = bidAsk(last);
    cash += basketPnl(opts.symbol, opts.direction, legs, bid, ask);
  }

  return { equityCurve, tpCount, slCount, tpUsd, slUsd, finalEquity: cash };
}

function metricsFromCurve(
  curve: { t: string; equity: number }[],
  seed: number,
  counts: { tpCount: number; slCount: number; tpUsd: number; slUsd: number },
): SimMetrics {
  if (!curve.length) {
    return {
      seed,
      finalEquity: seed,
      totalReturnPct: 0,
      medianMonthReturnPct: 0,
      consistency: 0,
      maxDrawdownPct: 0,
      ...counts,
      months: [],
      score: -1e9,
    };
  }

  let peak = curve[0]!.equity;
  let maxDd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - p.equity) / peak) * 100);
  }

  const byMonth = new Map<string, { start: number; end: number }>();
  for (const p of curve) {
    const m = monthKey(p.t);
    const row = byMonth.get(m);
    if (!row) byMonth.set(m, { start: p.equity, end: p.equity });
    else row.end = p.equity;
  }
  const months: MonthStat[] = [...byMonth.entries()].map(([month, v]) => ({
    month,
    startEquity: v.start,
    endEquity: v.end,
    returnPct: v.start > 0 ? ((v.end - v.start) / v.start) * 100 : 0,
    tpCount: 0,
    slCount: 0,
    tpUsd: 0,
    slUsd: 0,
  }));

  const returns = months.map((m) => m.returnPct).sort((a, b) => a - b);
  const mid = Math.floor(returns.length / 2);
  const medianMonthReturnPct =
    returns.length === 0
      ? 0
      : returns.length % 2
        ? returns[mid]!
        : (returns[mid - 1]! + returns[mid]!) / 2;
  const consistency =
    months.length === 0 ? 0 : months.filter((m) => m.returnPct > 0).length / months.length;
  const finalEquity = curve[curve.length - 1]!.equity;
  const totalReturnPct = seed > 0 ? ((finalEquity - seed) / seed) * 100 : 0;
  const score =
    medianMonthReturnPct * 1.2 +
    consistency * 5 +
    Math.min(30, totalReturnPct) * 0.05 -
    maxDd * 0.08 -
    counts.slCount * 0.5;

  return {
    seed,
    finalEquity,
    totalReturnPct,
    medianMonthReturnPct,
    consistency,
    maxDrawdownPct: maxDd,
    ...counts,
    months,
    score,
  };
}

function combineDualCurves(
  buy: { t: string; equity: number }[],
  sell: { t: string; equity: number }[],
  halfSeed: number,
  fullSeed: number,
) {
  const map = new Map<string, { b: number; s: number }>();
  for (const p of buy) {
    const cur = map.get(p.t) ?? { b: halfSeed, s: halfSeed };
    cur.b = p.equity;
    map.set(p.t, cur);
  }
  for (const p of sell) {
    const cur = map.get(p.t) ?? { b: halfSeed, s: halfSeed };
    cur.s = p.equity;
    map.set(p.t, cur);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, v]) => ({
      t,
      equity: fullSeed + (v.b - halfSeed) + (v.s - halfSeed),
    }));
}

/** Run candidate on bars across seeds; conservative aggregate for gates. */
export function simulateCandidate(
  candidate: FactoryCandidate,
  bars: FactoryBar[],
  seeds: number[],
): SimMetrics {
  if (!candidate.runnable || !candidate.levels.length || !bars.length) {
    return {
      seed: seeds[0] ?? 1000,
      finalEquity: seeds[0] ?? 1000,
      totalReturnPct: 0,
      medianMonthReturnPct: -999,
      consistency: 0,
      maxDrawdownPct: 100,
      tpCount: 0,
      slCount: 0,
      tpUsd: 0,
      slUsd: 0,
      months: [],
      score: -1e9,
    };
  }

  const perSeed: SimMetrics[] = [];
  for (const seed of seeds) {
    if (candidate.dualDirection) {
      const half = seed / 2;
      const buy = simulateOneSide({
        symbol: candidate.symbol,
        direction: "BUY",
        levels: candidate.levels,
        takeProfitPct: candidate.bot.takeProfitPct,
        stopLossPct: candidate.bot.stopLossPct,
        repeatEnabled: candidate.bot.repeatEnabled,
        bars,
        seed: half,
      });
      const sell = simulateOneSide({
        symbol: candidate.symbol,
        direction: "SELL",
        levels: candidate.levels,
        takeProfitPct: candidate.bot.takeProfitPct,
        stopLossPct: candidate.bot.stopLossPct,
        repeatEnabled: candidate.bot.repeatEnabled,
        bars,
        seed: half,
      });
      const curve = combineDualCurves(buy.equityCurve, sell.equityCurve, half, seed);
      perSeed.push(
        metricsFromCurve(curve, seed, {
          tpCount: buy.tpCount + sell.tpCount,
          slCount: buy.slCount + sell.slCount,
          tpUsd: buy.tpUsd + sell.tpUsd,
          slUsd: buy.slUsd + sell.slUsd,
        }),
      );
    } else {
      const sim = simulateOneSide({
        symbol: candidate.symbol,
        direction: candidate.direction,
        levels: candidate.levels,
        takeProfitPct: candidate.bot.takeProfitPct,
        stopLossPct: candidate.bot.stopLossPct,
        repeatEnabled: candidate.bot.repeatEnabled,
        bars,
        seed,
      });
      perSeed.push(
        metricsFromCurve(sim.equityCurve, seed, {
          tpCount: sim.tpCount,
          slCount: sim.slCount,
          tpUsd: sim.tpUsd,
          slUsd: sim.slUsd,
        }),
      );
    }
  }

  const primary = perSeed[0]!;
  return {
    seed: primary.seed,
    finalEquity: primary.finalEquity,
    totalReturnPct: primary.totalReturnPct,
    medianMonthReturnPct: Math.min(...perSeed.map((m) => m.medianMonthReturnPct)),
    consistency: Math.min(...perSeed.map((m) => m.consistency)),
    maxDrawdownPct: Math.max(...perSeed.map((m) => m.maxDrawdownPct)),
    tpCount: primary.tpCount,
    slCount: primary.slCount,
    tpUsd: primary.tpUsd,
    slUsd: primary.slUsd,
    months: primary.months,
    score: perSeed.reduce((s, m) => s + m.score, 0) / perSeed.length,
  };
}
