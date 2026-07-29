import type { StrategyPayload } from "@/lib/table-logics";
import type { DirectionPolicy, StrategyGenomeV1 } from "./genome";

export type CompiledLevel = {
  lots: number;
  profit: number;
  drop: number;
};

export type CompiledStrategy = {
  genomeId: string;
  runnable: true;
  /** Maps to StrategyLogic custom payload */
  payload: StrategyPayload;
  /** SymbolBot-facing knobs (not auto-applied) */
  bot: {
    logic: "custom";
    direction: "BUY" | "SELL";
    dualDirection: boolean;
    startLots: number;
    entryCount: number;
    takeProfitPct: number;
    stopLossPct: number;
    repeatEnabled: boolean;
    stopOnSl: boolean;
  };
  levels: CompiledLevel[];
  summaryKo: string;
};

function roundLot(n: number) {
  return Math.max(0.01, Math.round(n * 100) / 100);
}

function roundDrop(n: number) {
  if (n <= 0) return 0;
  if (n < 10) return Math.round(n * 10) / 10;
  return Math.round(n);
}

function fib(n: number) {
  // 1-indexed fib: 1,1,2,3,5...
  let a = 1;
  let b = 1;
  for (let i = 1; i < n; i++) {
    const c = a + b;
    a = b;
    b = c;
  }
  return a;
}

/** Build absolute adverse ROI drop thresholds for L0..L(n-1). L0=0, then non-decreasing. */
export function buildDropLadder(g: StrategyGenomeV1): number[] {
  const n = Math.max(2, Math.min(60, g.rounds));
  const drops = new Array<number>(n).fill(0);
  const base = Math.max(1, g.spacing.baseDropRoi);
  const growth = Math.max(0.1, g.spacing.growth);

  for (let i = 1; i < n; i++) {
    let abs = 0;
    switch (g.spacingFamily) {
      case "arithmetic":
        abs = base * i;
        break;
      case "geometric": {
        // cumulative: base * (r^i - 1)/(r-1) style stepwise
        let step = base;
        abs = 0;
        for (let k = 1; k <= i; k++) {
          abs += step;
          step *= growth;
        }
        break;
      }
      case "fibonacci":
        abs = base * fib(i);
        break;
      case "clustered": {
        const width = Math.max(1, Math.round(growth));
        const band = Math.ceil(i / width);
        abs = base * band;
        break;
      }
      case "accelerating": {
        let step = base;
        abs = 0;
        for (let k = 1; k <= i; k++) {
          abs += step;
          step *= growth;
        }
        break;
      }
      case "decelerating": {
        let step = base;
        abs = 0;
        for (let k = 1; k <= i; k++) {
          abs += step;
          step *= growth; // growth < 1
        }
        break;
      }
      case "freeform_mono":
      default: {
        // Smooth-ish mono curve from base with mild noise factor baked into growth
        abs = base * i * (0.85 + 0.15 * growth) * (1 + 0.08 * Math.sin(i * 1.7));
        break;
      }
    }
    drops[i] = roundDrop(Math.min(5000, Math.max(drops[i - 1]! + 1, abs)));
  }
  // Enforce strict non-decreasing & L0=0
  drops[0] = 0;
  for (let i = 1; i < n; i++) {
    drops[i] = Math.max(drops[i]!, drops[i - 1]!);
    if (i > 1 && drops[i] === drops[i - 1]) {
      // allow equal (clustered) — engine uses absolute ROI thresholds
    }
  }
  return drops;
}

export function buildLotLadder(g: StrategyGenomeV1): number[] {
  const n = Math.max(2, Math.min(60, g.rounds));
  const start = Math.max(0.01, g.lots.startLots);
  const m = Math.max(1.01, g.lots.multiplier);
  const lots: number[] = [];

  for (let i = 0; i < n; i++) {
    let raw = start;
    switch (g.lotFamily) {
      case "martingale":
        raw = start * Math.pow(m, i);
        break;
      case "anti_martingale":
        // largest first, shrink toward end
        raw = start * Math.pow(m, Math.max(0, n - 1 - i));
        break;
      case "flat":
        raw = start;
        break;
      case "fibonacci":
        raw = start * fib(i + 1);
        break;
      case "u_shape": {
        const mid = (n - 1) / 2;
        const dist = Math.abs(i - mid) / Math.max(1, mid);
        raw = start * (1 + dist * (m - 1));
        break;
      }
      case "freeform_positive":
      default:
        raw = start * Math.pow(1 + (m - 1) * 0.65, i) * (1 + 0.05 * Math.sin(i * 2.1));
        break;
    }
    lots.push(roundLot(Math.min(100, raw)));
  }
  return lots;
}

function directionToBot(dir: DirectionPolicy): {
  direction: "BUY" | "SELL";
  dualDirection: boolean;
} {
  if (dir === "DUAL") return { direction: "BUY", dualDirection: true };
  return { direction: dir, dualDirection: false };
}

/**
 * Compile genome → custom StrategyPayload + bot knobs.
 * Does NOT write DB / does NOT touch live baskets.
 */
export function compileGenome(g: StrategyGenomeV1): CompiledStrategy {
  const drops = buildDropLadder(g);
  const lots = buildLotLadder(g);
  const n = drops.length;
  const tp = Math.min(500, Math.max(1, Math.round(g.takeProfitPct)));
  const lastDrop = drops[n - 1] ?? 0;
  const sl = Math.min(5000, Math.max(lastDrop + 1, Math.round(g.stopLossPct)));

  const levels: CompiledLevel[] = [];
  for (let i = 0; i < n; i++) {
    levels.push({
      lots: lots[i]!,
      profit: tp,
      drop: drops[i]!,
    });
  }

  const startLots = levels[0]!.lots;
  const botDir = directionToBot(g.direction);

  const payload: StrategyPayload = {
    mode: "levels",
    startLots,
    takeProfitPct: tp,
    stopLossPct: sl,
    levels,
  };

  const summaryKo = [
    `신규발명 래더 · ${g.id}`,
    `방향 ${g.direction} · 회차 N=${n} · 간격 ${g.spacingFamily} · 로트 ${g.lotFamily}`,
    `익절 ROI ${tp}% · 손절 ROI ${sl}% (바스켓) · 엔진 custom 컴파일 가능`,
    `드롭(ROI%): [${drops.join(", ")}]`,
    `로트: [${lots.join(", ")}]`,
    `※ 자동 적용 안 함 — 발굴 후보만`,
  ].join("\n");

  return {
    genomeId: g.id,
    runnable: true,
    payload,
    bot: {
      logic: "custom",
      direction: botDir.direction,
      dualDirection: botDir.dualDirection,
      startLots,
      entryCount: n,
      takeProfitPct: tp,
      stopLossPct: sl,
      repeatEnabled: g.repeatEnabled,
      stopOnSl: g.stopOnSl,
    },
    levels,
    summaryKo,
  };
}

/** Soft fingerprint to detect near-duplicates of registered martin shapes (informational). */
export function resemblesMartinPreset(drops: number[]): boolean {
  // martin_9_65 approx: 0,97,195,195,292,292,292,390,390
  const core = [0, 97, 195, 195, 292, 292, 292, 390, 390];
  if (drops.length !== core.length) return false;
  let err = 0;
  for (let i = 0; i < core.length; i++) {
    err += Math.abs((drops[i] ?? 0) - core[i]!);
  }
  return err / core.length < 15;
}
