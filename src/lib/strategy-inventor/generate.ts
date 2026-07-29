import {
  DIRECTION_POLICIES,
  LOT_FAMILIES,
  SPACING_FAMILIES,
  type DirectionPolicy,
  type InventedCandidate,
  type LotFamily,
  type MechanismSketch,
  type SpacingFamily,
  type StrategyGenomeV1,
} from "./genome";

/** Mulberry32 — deterministic invent/mutate for replayable discovery runs. */
export function createRng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function randInt(rng: () => number, min: number, max: number) {
  return min + Math.floor(rng() * (max - min + 1));
}

function randFloat(rng: () => number, min: number, max: number, digits = 2) {
  const v = min + rng() * (max - min);
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function shortId(rng: () => number) {
  return Math.floor(rng() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}

function inventSpacing(rng: () => number): StrategyGenomeV1["spacing"] & {
  spacingFamily: SpacingFamily;
} {
  const spacingFamily = pick(rng, SPACING_FAMILIES);
  // ROI% bands — keep within API drop max 5000 after expansion
  switch (spacingFamily) {
    case "arithmetic":
      return { spacingFamily, baseDropRoi: randFloat(rng, 15, 120, 0), growth: 1 };
    case "geometric":
      return {
        spacingFamily,
        baseDropRoi: randFloat(rng, 12, 80, 0),
        growth: randFloat(rng, 1.15, 1.85, 2),
      };
    case "fibonacci":
      return { spacingFamily, baseDropRoi: randFloat(rng, 10, 60, 0), growth: 1 };
    case "clustered":
      return {
        spacingFamily,
        baseDropRoi: randFloat(rng, 20, 100, 0),
        growth: randInt(rng, 2, 4), // cluster width
      };
    case "accelerating":
      return {
        spacingFamily,
        baseDropRoi: randFloat(rng, 10, 50, 0),
        growth: randFloat(rng, 1.2, 2.2, 2),
      };
    case "decelerating":
      return {
        spacingFamily,
        baseDropRoi: randFloat(rng, 40, 150, 0),
        growth: randFloat(rng, 0.55, 0.9, 2),
      };
    case "freeform_mono":
    default:
      return {
        spacingFamily: "freeform_mono",
        baseDropRoi: randFloat(rng, 15, 90, 0),
        growth: randFloat(rng, 0.8, 1.6, 2),
      };
  }
}

function inventLots(rng: () => number): StrategyGenomeV1["lots"] & {
  lotFamily: LotFamily;
} {
  const lotFamily = pick(rng, LOT_FAMILIES);
  const startLots = randFloat(rng, 0.01, 0.1, 2);
  switch (lotFamily) {
    case "martingale":
      return { lotFamily, startLots, multiplier: randFloat(rng, 1.2, 2.4, 2) };
    case "anti_martingale":
      return { lotFamily, startLots: randFloat(rng, 0.05, 0.2, 2), multiplier: randFloat(rng, 1.2, 2.0, 2) };
    case "flat":
      return { lotFamily, startLots, multiplier: 1 };
    case "fibonacci":
      return { lotFamily, startLots, multiplier: 1 };
    case "u_shape":
      return { lotFamily, startLots, multiplier: randFloat(rng, 1.3, 2.0, 2) };
    case "freeform_positive":
    default:
      return {
        lotFamily: "freeform_positive",
        startLots,
        multiplier: randFloat(rng, 1.1, 1.8, 2),
      };
  }
}

export function inventLadderGenome(seed: number): StrategyGenomeV1 {
  const rng = createRng(seed);
  const spacing = inventSpacing(rng);
  const lots = inventLots(rng);
  const rounds = randInt(rng, 3, 14);
  const takeProfitPct = randFloat(rng, 4, 25, 0);
  // SL deep enough that later drops can fill; clamped to API max later
  const stopLossPct = randFloat(rng, 200, 2500, 0);
  const direction = pick(rng, DIRECTION_POLICIES) as DirectionPolicy;
  const id = `invent-${shortId(rng)}`;

  return {
    version: 1,
    id,
    spacingFamily: spacing.spacingFamily,
    lotFamily: lots.lotFamily,
    exitFamily: "basket_roi_tp_sl",
    direction,
    rounds,
    spacing: { baseDropRoi: spacing.baseDropRoi, growth: spacing.growth },
    lots: { startLots: lots.startLots, multiplier: lots.multiplier },
    takeProfitPct,
    stopLossPct,
    repeatEnabled: rng() > 0.15,
    stopOnSl: rng() > 0.35,
    runnable: true,
    requiresEngine: [],
  };
}

/** Mutate structural DNA — can change families, not just numeric knobs. */
export function mutateLadderGenome(parent: StrategyGenomeV1, seed: number): StrategyGenomeV1 {
  const rng = createRng(seed);
  const child = inventLadderGenome((seed ^ 0x9e3779b9) >>> 0);
  // 40%: keep parent's family axes, remix knobs; else full structural child
  if (rng() < 0.4) {
    return {
      ...parent,
      id: `mut-${shortId(rng)}`,
      rounds: Math.min(60, Math.max(2, parent.rounds + randInt(rng, -2, 2))),
      spacing: {
        baseDropRoi: clamp(
          parent.spacing.baseDropRoi * randFloat(rng, 0.7, 1.35, 2),
          5,
          200,
        ),
        growth: clamp(parent.spacing.growth * randFloat(rng, 0.85, 1.2, 2), 0.4, 3),
      },
      lots: {
        startLots: clamp(
          Math.round(parent.lots.startLots * randFloat(rng, 0.7, 1.4, 2) * 100) / 100,
          0.01,
          1,
        ),
        multiplier: clamp(parent.lots.multiplier * randFloat(rng, 0.85, 1.2, 2), 1, 3),
      },
      takeProfitPct: clamp(
        Math.round(parent.takeProfitPct * randFloat(rng, 0.75, 1.3, 2)),
        1,
        500,
      ),
      stopLossPct: clamp(
        Math.round(parent.stopLossPct * randFloat(rng, 0.75, 1.3, 2)),
        50,
        5000,
      ),
      direction: rng() < 0.25 ? pick(rng, DIRECTION_POLICIES) : parent.direction,
      runnable: true,
      requiresEngine: [],
    };
  }
  return {
    ...child,
    id: `mut-${shortId(rng)}`,
  };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

const SKETCH_POOL: Omit<MechanismSketch, "id">[] = [
  {
    version: 1,
    runnable: false,
    requiresEngine: ["price_pct_dca", "session_filter"],
    headline: "런던오픈 가격% 물타기 + 세션 밖 신규금지",
    entryRule: "London open ±30m only; SELL if M15 close > VWAP",
    dcaRule: "Adverse price% from P0 (not margin ROI), geometric 0.15%×1.4^i",
    exitRule: "Partial TP 50% at +0.08% price, trail rest; hard SL −1.2% price",
    notes: "Needs price-based DCA + partial close — not in runSymbolTableDca today",
  },
  {
    version: 1,
    runnable: false,
    requiresEngine: ["indicator_entry", "hedge_leg"],
    headline: "RSI 과매수 숏 + 헤지 다리",
    entryRule: "RSI(14) M5 > 72 → SELL; < 28 → BUY",
    dcaRule: "Only add when RSI stays extreme 2 bars; flat lots",
    exitRule: "Basket TP 8% ROI or RSI mean-revert cross 50",
    notes: "Needs indicator feed + optional hedgeEnabled wiring",
  },
  {
    version: 1,
    runnable: false,
    requiresEngine: ["anti_cluster_time", "tod_schedule"],
    headline: "시간대 가중 안티마틴",
    entryRule: "Asia session BUY bias; NY session SELL bias (not H8 barOpen)",
    dcaRule: "Anti-martingale: add only after floating ROI > +5%",
    exitRule: "Scale-out every +4% ROI; flatten before Fri close 2h",
    notes: "Needs TOD DNA + scale-out; H8 time logics are fixed bar opens only",
  },
  {
    version: 1,
    runnable: false,
    requiresEngine: ["multi_symbol", "correlation_gate"],
    headline: "GBP/EUR 상관 게이트 바스켓",
    entryRule: "Enter GBPUSD SELL only if EURUSD same-direction momentum confirms",
    dcaRule: "Standard ROI ladder but freeze adds when correlation breaks",
    exitRule: "Basket ROI TP 10%; emergency flatten if pair spread z-score blows",
    notes: "Per-symbol bots only today — needs portfolio layer",
  },
  {
    version: 1,
    runnable: false,
    requiresEngine: ["grid_entry", "independent_legs"],
    headline: "대칭 그리드 (마틴 아님)",
    entryRule: "Place ±N pending levels around mid; no first market martingale",
    dcaRule: "Each grid touch is independent leg with own micro TP",
    exitRule: "Per-leg TP; basket SL on net equity drawdown % of seed",
    notes: "Engine is basket ROI DCA, not pending-grid",
  },
];

export function inventMechanismSketch(seed: number): MechanismSketch {
  const rng = createRng(seed);
  const base = pick(rng, SKETCH_POOL);
  return {
    ...base,
    id: `sketch-${shortId(rng)}`,
  };
}

export type InventBatchOptions = {
  seed: number;
  count: number;
  /** Fraction of candidates that are non-runnable frontier sketches (0..1) */
  sketchRatio?: number;
  /** Optional parents to mutate instead of pure invent */
  parents?: StrategyGenomeV1[];
};

export function inventBatch(opts: InventBatchOptions): InventedCandidate[] {
  const sketchRatio = Math.min(0.5, Math.max(0, opts.sketchRatio ?? 0.15));
  const out: InventedCandidate[] = [];
  for (let i = 0; i < opts.count; i++) {
    const seed = (opts.seed + i * 9973) >>> 0;
    const rng = createRng(seed);
    if (rng() < sketchRatio) {
      const sketch = inventMechanismSketch(seed);
      out.push({
        kind: "sketch",
        sketch,
        label: `${sketch.id} · ${sketch.headline}`,
      });
      continue;
    }
    const parent = opts.parents?.length ? pick(rng, opts.parents) : null;
    const genome = parent ? mutateLadderGenome(parent, seed) : inventLadderGenome(seed);
    out.push({
      kind: "ladder",
      genome,
      label: ladderLabel(genome),
    });
  }
  return out;
}

export function ladderLabel(g: StrategyGenomeV1) {
  const dir =
    g.direction === "DUAL" ? "DUAL" : g.direction;
  return `${g.id} · ${dir} · N${g.rounds} · tp${g.takeProfitPct} · ${g.spacingFamily}/${g.lotFamily}`;
}
