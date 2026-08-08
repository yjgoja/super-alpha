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
import { rebateUsd, spreadInPrice, STOPOUT_LEVEL_PCT } from "./costs";
import { isFxMarketClosed, isInOpenBurstQuietPeriod } from "@/lib/market-hours";
import type { FactoryBar } from "./bars";
import type {
  FactoryCandidate,
  FactoryLevel,
  MonthStat,
  SeedFact,
  SimMetrics,
} from "./types";

type Leg = { lots: number; price: number; level: number };
/** 월별 체결 집계 — MonthStat 의 거래 칸을 채우기 위한 것. */
type MonthTrades = {
  tpCount: number;
  slCount: number;
  tpUsd: number;
  slUsd: number;
  /** 그 달에 체결된 로트 합계 — 리베이트 산정용 */
  lots: number;
};

/** DUAL 후보는 BUY/SELL 두 시뮬의 월별 집계를 합친다. */
function mergeMonthly(
  a: Map<string, MonthTrades>,
  b: Map<string, MonthTrades>,
): Map<string, MonthTrades> {
  const out = new Map<string, MonthTrades>();
  for (const src of [a, b]) {
    for (const [k, v] of src) {
      const row = out.get(k) ?? { tpCount: 0, slCount: 0, tpUsd: 0, slUsd: 0, lots: 0 };
      row.tpCount += v.tpCount;
      row.slCount += v.slCount;
      row.tpUsd += v.tpUsd;
      row.slUsd += v.slUsd;
      row.lots += v.lots;
      out.set(k, row);
    }
  }
  return out;
}

function monthKey(iso: string) {
  return iso.slice(0, 7);
}

/**
 * 실측 브로커 스프레드를 쓴다.
 *
 * 예전에는 바에 붙은 spread(합성 바는 XAU 0.25 / GBP 0.00012)를 그대로 썼는데,
 * 실제(XAU $40/랏 = 0.40, FX $28/랏 = 0.00028)의 절반 이하라 백테스트가
 * 낙관적으로 나왔다. 바에 더 넓은 실측 스프레드가 있으면 그쪽을 쓴다.
 */
function bidAsk(bar: FactoryBar, symbol: string): { bid: number; ask: number } {
  const mid = bar.close;
  // bar.spread 는 쓰지 않는다.
  // MetaAPI 캔들의 spread 는 '포인트' 단위다 (EURUSD 첫 바 = 74 → 0.00074).
  // 예전 코드는 이걸 가격 델타로 그대로 썼는데, 합성 바에서는 값이 작아
  // 티가 안 났지만 실제 데이터를 물리면 스프레드가 74가 되어 계산이 무너진다.
  // 오너 실측 비용($/랏)을 가격으로 환산해 쓰는 쪽이 단위 사고도 없고 실전에 맞다.
  const sp = spreadInPrice(symbol);
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
  // 월별 체결 집계. MonthStat 의 tpCount/slCount/tpUsd/slUsd 가 0 으로 하드코딩돼
  // 있어서 일일 보고의 월별 익절·손절 칸이 늘 비어 있었다.
  const monthly = new Map<string, MonthTrades>();
  // 리베이트는 체결 로트 합계에 붙는다. 진입·물타기마다 로트를 적립한다.
  let lotsTraded = 0;
  /** 강제청산 횟수 — 실계좌에서 계좌가 날아간 횟수다. */
  let stoppedOutCount = 0;
  // 낙폭도 캔들 내부 기준으로 잡는다. 종가만 보면 분 안에서 파인 골이 통째로
  // 사라져 낙폭이 실제보다 얕게 나온다.
  let peakEquity = opts.seed;
  let maxDdPct = 0;
  const bumpMonthLots = (t: string, lots: number) => {
    const k = monthKey(t);
    const row = monthly.get(k) ?? { tpCount: 0, slCount: 0, tpUsd: 0, slUsd: 0, lots: 0 };
    row.lots += lots;
    monthly.set(k, row);
  };
  const bumpMonth = (t: string, kind: "tp" | "sl", usd: number) => {
    const k = monthKey(t);
    const row = monthly.get(k) ?? { tpCount: 0, slCount: 0, tpUsd: 0, slUsd: 0, lots: 0 };
    if (kind === "tp") {
      row.tpCount += 1;
      row.tpUsd += Math.max(0, usd);
    } else {
      row.slCount += 1;
      row.slUsd += Math.max(0, -usd);
    }
    monthly.set(k, row);
  };
  let allowEntry = true;

  const sp = spreadInPrice(opts.symbol);
  /**
   * 엔진과 같은 신규 리스크 차단 규칙 (meta-engine 이 7군데서 강제하는 것).
   *   - 폐장 중 진입 금지
   *   - 개장 직후 15분(KST 09:00 / 17:00 / 22:30) 진입 금지
   */
  const canOpenAt = (iso: string) => {
    const t = new Date(iso);
    if (isFxMarketClosed(t)) return false;
    if (isInOpenBurstQuietPeriod(t).active) return false;
    return true;
  };
  /** 캔들 안에서 이 방향에 가장 불리한 / 유리한 지점 */
  const extremes = (bar: FactoryBar) => {
    const advMid = opts.direction === "BUY" ? bar.low : bar.high;
    const favMid = opts.direction === "BUY" ? bar.high : bar.low;
    return {
      adv: { bid: advMid - sp / 2, ask: advMid + sp / 2 },
      fav: { bid: favMid - sp / 2, ask: favMid + sp / 2 },
    };
  };

  for (const bar of opts.bars) {
    const { bid, ask } = bidAsk(bar, opts.symbol);

    if (!legs.length) {
      // 엔진이 실제로 막는 시간대는 백테스트에서도 막아야 한다.
      // meta-engine 은 폐장(isFxMarketClosed)과 개장 직후 15분
      // (isInOpenBurstQuietPeriod)에 신규 진입을 거부하는데, 백테스트는
      // market-hours 를 아예 import 하지 않아 실전에서 나오지 않을 진입으로
      // 성과를 만들고 있었다.
      if (allowEntry && canOpenAt(bar.time)) {
        const px = mt5EntryQuote(opts.direction, bid, ask);
        const lots = levels[0]?.lots ?? 0.01;
        legs = [{ lots, price: px, level: 0 }];
        lotsTraded += lots;
        bumpMonthLots(bar.time, lots);
        nextLevel = 1;
        if (!opts.repeatEnabled) allowEntry = false;
      }
      equityCurve.push({ t: bar.time, equity: cash });
      continue;
    }

    const margin = basketMargin(opts.symbol, legs);

    // 캔들 내부 경로를 반영한다.
    //
    // 예전에는 종가로만 판정해서, 1분 안에 강제청산·손절선을 뚫고 되돌아온
    // 움직임이 통째로 무시됐다. 마틴게일은 바로 그 순간에 죽는다.
    // M1 안에서 고가/저가 중 어느 쪽이 먼저인지는 알 수 없으므로
    // **불리한 쪽을 먼저** 본다 (보수적).
    const { adv, fav } = extremes(bar);
    const pnlAdv = basketPnl(opts.symbol, opts.direction, legs, adv.bid, adv.ask);
    const pnlFav = basketPnl(opts.symbol, opts.direction, legs, fav.bid, fav.ask);

    peakEquity = Math.max(peakEquity, cash + pnlFav);
    if (peakEquity > 0) {
      // 순자산은 0 밑으로 못 내려간다 (계좌가 사라지는 것이 바닥). 갭으로 잠깐
      // 마이너스가 찍혀도 낙폭은 100% 가 상한이다.
      const trough = Math.max(0, cash + pnlAdv);
      maxDdPct = Math.min(100, Math.max(maxDdPct, ((peakEquity - trough) / peakEquity) * 100));
    }

    // 강제청산(스톱아웃) — 실계좌에는 있고 시뮬에는 없던 것.
    //
    // 없을 때는 순자산이 마이너스로 내려가도 시뮬이 태연히 버티다 회복해서,
    // 낙폭 128% 같은 현실에 없는 결과가 나왔다. MT5 는 마진레벨
    // (순자산 / 사용증거금 × 100)이 스톱아웃선 밑으로 가면 강제청산한다.
    // 1) 강제청산 — 가장 불리한 지점에서 판정. 청산은 시장가라 그 시점 손익 그대로.
    {
      const equity = cash + pnlAdv;
      const marginLevel = margin > 0 ? (equity / margin) * 100 : Infinity;
      if (marginLevel < STOPOUT_LEVEL_PCT) {
        cash = Math.max(0, equity);
        slCount += 1;
        slUsd += Math.max(0, -pnlAdv);
        bumpMonth(bar.time, "sl", pnlAdv);
        stoppedOutCount += 1;
        legs = [];
        nextLevel = 0;
        // 잔고가 남았으면 다시 시작할 수 있지만, 0 이면 계좌가 끝난 것이다.
        allowEntry = opts.repeatEnabled && cash > 0;
        equityCurve.push({ t: bar.time, equity: cash });
        if (cash <= 0) break;
        continue;
      }
    }

    // 2) 손절 — 불리한 지점에서 판정하되 체결은 손절선에서 된다 (지정가처럼).
    const sl = shouldTriggerStopLossUsd({
      pnl: pnlAdv,
      stopLossUsd: 0,
      usedMargin: margin,
      stopLossRoiPct: opts.stopLossPct,
    });
    if (sl.hit) {
      const slMoney = (margin * opts.stopLossPct) / 100;
      const realized = -Math.min(slMoney, Math.abs(pnlAdv));
      cash += realized;
      slCount += 1;
      slUsd += Math.max(0, -realized);
      bumpMonth(bar.time, "sl", realized);
      legs = [];
      nextLevel = 0;
      allowEntry = false;
      equityCurve.push({ t: bar.time, equity: cash });
      continue;
    }

    // 3) 익절 — 유리한 지점에서 판정하되 체결은 익절선에서 된다.
    const tp = shouldTriggerTakeProfit({
      pnl: pnlFav,
      takeProfitUsd: 0,
      usedMargin: margin,
      tpRoiPct: opts.takeProfitPct,
    });
    if (tp.hit) {
      const tpMoney = (margin * opts.takeProfitPct) / 100;
      const realized = Math.min(tpMoney, pnlFav);
      cash += realized;
      tpCount += 1;
      tpUsd += Math.max(0, realized);
      bumpMonth(bar.time, "tp", realized);
      legs = [];
      nextLevel = 0;
      allowEntry = opts.repeatEnabled;
      equityCurve.push({ t: bar.time, equity: cash });
      continue;
    }

    // 4) 물타기 — 불리한 지점에서 트리거되고, 그 가격에 체결된다.
    //    물타기도 신규 리스크라 엔진의 시간 규칙을 똑같이 받는다.
    if (nextLevel < levels.length && canOpenAt(bar.time)) {
      const drop = levels[nextLevel]?.drop ?? 0;
      const dca = shouldTriggerDcaRoi({ pnl: pnlAdv, usedMargin: margin, dropRoiPct: drop });
      if (dca.hit) {
        const px = mt5EntryQuote(opts.direction, adv.bid, adv.ask);
        const addLots = levels[nextLevel]!.lots;
        legs.push({ lots: addLots, price: px, level: nextLevel });
        lotsTraded += addLots;
        bumpMonthLots(bar.time, addLots);
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
    const { bid, ask } = bidAsk(last, opts.symbol);
    cash += basketPnl(opts.symbol, opts.direction, legs, bid, ask);
  }

  return { equityCurve, tpCount, slCount, tpUsd, slUsd, monthly, lotsTraded, stoppedOutCount, maxDdPct, finalEquity: cash };
}

function metricsFromCurve(
  curve: { t: string; equity: number }[],
  seed: number,
  counts: { tpCount: number; slCount: number; tpUsd: number; slUsd: number },
  monthly?: Map<string, MonthTrades>,
  lotsTraded = 0,
  stoppedOutCount = 0,
  /** 캔들 내부 기준 낙폭. 종가 곡선만으로는 분 안의 골이 안 보인다. */
  intraBarMaxDdPct = 0,
): SimMetrics {
  if (!curve.length) {
    return {
      seed,
      finalEquity: seed,
      totalReturnPct: 0,
      medianMonthReturnPct: 0,
      consistency: 0,
      maxDrawdownPct: 0,
      lotsTraded: 0,
      rebateUsd: 0,
      stoppedOutCount: 0,
      seeds: [],
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
  const months: MonthStat[] = [...byMonth.entries()].map(([month, v]) => {
    const t = monthly?.get(month);
    return {
      month,
      startEquity: v.start,
      endEquity: v.end,
      returnPct: v.start > 0 ? ((v.end - v.start) / v.start) * 100 : 0,
      tpCount: t?.tpCount ?? 0,
      slCount: t?.slCount ?? 0,
      tpUsd: t?.tpUsd ?? 0,
      slUsd: t?.slUsd ?? 0,
      lots: t?.lots ?? 0,
      rebateUsd: rebateUsd(t?.lots ?? 0),
    };
  });

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
  // 점수 — 유전 알고리즘이 이 값을 따라 진화하므로 방향이 곧 탐색 방향이다.
  //
  // 예전 공식:
  //   월수익률×1.2 + 일관성×5 + min(30,총수익)×0.05 − 낙폭×0.08 − 손절수×0.5
  // 문제:
  //   1) 손절 수를 개수로 빼서, 손실을 감수하고 벌어들이는 전략이 무조건 손해였다.
  //   2) 낙폭도 상수로 빼서, 거래를 안 할수록 점수가 올라갔다.
  //   3) 활동량 조건이 없어 거래 1건짜리가 1위로 올라왔다.
  //   4) 강제청산(계좌 소멸)이 점수에 전혀 반영되지 않았다.
  //
  // 지금 공식: 위험조정 수익 × 활동량 × 일관성 − 강제청산 벌점.
  // 감점을 곱셈으로 바꿔서 "거래를 안 하면 점수가 0 에 수렴"하게 만든다.
  const tradesPerMonth =
    months.length > 0 ? (counts.tpCount + counts.slCount) / months.length : 0;
  /** 월 이 정도는 거래해야 제 점수를 받는다. 미달이면 비례해서 깎인다. */
  const targetTrades = Math.max(1, Number(process.env.FACTORY_SCORE_TARGET_TRADES || 4));
  const activity = Math.min(1, tradesPerMonth / targetTrades);
  /** 낙폭 50% 면 수익을 절반으로 본다. */
  const riskAdjusted = medianMonthReturnPct / (1 + maxDd / 50);
  const consistencyFactor = 0.5 + consistency * 0.5;
  const score =
    riskAdjusted * activity * consistencyFactor - stoppedOutCount * 50;

  return {
    seed,
    finalEquity,
    totalReturnPct,
    medianMonthReturnPct,
    consistency,
    maxDrawdownPct: Math.max(maxDd, intraBarMaxDdPct),
    lotsTraded,
    rebateUsd: rebateUsd(lotsTraded),
    stoppedOutCount,
    seeds: [],
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
      lotsTraded: 0,
      rebateUsd: 0,
      stoppedOutCount: 0,
      seeds: [],
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
        metricsFromCurve(
          curve,
          seed,
          {
            tpCount: buy.tpCount + sell.tpCount,
            slCount: buy.slCount + sell.slCount,
            tpUsd: buy.tpUsd + sell.tpUsd,
            slUsd: buy.slUsd + sell.slUsd,
          },
          mergeMonthly(buy.monthly, sell.monthly),
          buy.lotsTraded + sell.lotsTraded,
          buy.stoppedOutCount + sell.stoppedOutCount,
          Math.max(buy.maxDdPct, sell.maxDdPct),
        ),
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
        metricsFromCurve(
          sim.equityCurve,
          seed,
          {
            tpCount: sim.tpCount,
            slCount: sim.slCount,
            tpUsd: sim.tpUsd,
            slUsd: sim.slUsd,
          },
          sim.monthly,
          sim.lotsTraded,
          sim.stoppedOutCount,
          sim.maxDdPct,
        ),
      );
    }
  }

  const primary = perSeed[0]!;
  // 시드별 요약. 월별 상세는 빼고 집계값만 남긴다 (산출물 크기).
  const seedFacts: SeedFact[] = perSeed.map((m) => ({
    seed: m.seed,
    medianMonthReturnPct: m.medianMonthReturnPct,
    consistency: m.consistency,
    maxDrawdownPct: m.maxDrawdownPct,
    tpCount: m.tpCount,
    slCount: m.slCount,
    tpUsd: m.tpUsd,
    slUsd: m.slUsd,
    lotsTraded: m.lotsTraded,
    rebateUsd: m.rebateUsd,
    finalEquity: m.finalEquity,
  }));
  return {
    seed: primary.seed,
    finalEquity: primary.finalEquity,
    totalReturnPct: primary.totalReturnPct,
    medianMonthReturnPct: Math.min(...perSeed.map((m) => m.medianMonthReturnPct)),
    consistency: Math.min(...perSeed.map((m) => m.consistency)),
    maxDrawdownPct: Math.max(...perSeed.map((m) => m.maxDrawdownPct)),
    lotsTraded: primary.lotsTraded,
    rebateUsd: primary.rebateUsd,
    // 시드 하나라도 강제청산됐으면 그 후보는 위험하다. 최악값을 쓴다.
    stoppedOutCount: Math.max(...perSeed.map((m) => m.stoppedOutCount)),
    seeds: seedFacts,
    tpCount: primary.tpCount,
    slCount: primary.slCount,
    tpUsd: primary.tpUsd,
    slUsd: primary.slUsd,
    months: primary.months,
    score: perSeed.reduce((s, m) => s + m.score, 0) / perSeed.length,
  };
}
