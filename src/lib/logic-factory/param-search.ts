import { createHash } from "crypto";
import {
  getMartin9Defense,
  isMartinLogic,
  lotsForLogicLevel,
  martinMaxLevels,
  presetToEditorRows,
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
} from "@/lib/table-logics";
import { PRIMARY_LOGIC_IDS } from "@/lib/strategies";
import {
  compileGenome,
  inventLadderGenome,
  inventMechanismSketch,
  mutateLadderGenome,
  type StrategyGenomeV1,
} from "@/lib/strategy-inventor";
import type { FactoryCandidate, FactoryLevel } from "./types";

function shortHash(s: string) {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

function mulberry(seed: number) {
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

function randFloat(rng: () => number, a: number, b: number, d = 2) {
  const p = 10 ** d;
  return Math.round((a + rng() * (b - a)) * p) / p;
}

const PRESET_LOGICS = PRIMARY_LOGIC_IDS.filter((id) => !id.endsWith("_time"));

/** Existing registered logics — only knobs change (lots / mult / dir / symbol). */
export function inventPresetParamCandidates(opts: {
  seed: number;
  count: number;
  symbols: string[];
}): FactoryCandidate[] {
  const rng = mulberry(opts.seed);
  const out: FactoryCandidate[] = [];
  for (let i = 0; i < opts.count; i++) {
    const logic = pick(rng, PRESET_LOGICS);
    const symbol = pick(rng, opts.symbols);
    const direction = rng() < 0.5 ? "BUY" : "SELL";
    const startLots = randFloat(rng, 0.01, 0.1, 2);
    const entryMultiplier = isMartinLogic(logic)
      ? randFloat(rng, 1.2, 2.5, 2)
      : 1;
    const rows = presetToEditorRows(logic, startLots, entryMultiplier);
    const defense = getMartin9Defense(logic);
    const tp = resolveLiveTakeProfitPct(logic, defense?.takeProfitPct ?? 10) ?? 10;
    const sl =
      resolveLiveStopLossPct(logic, defense?.stopLossPct ?? 225) ??
      defense?.stopLossPct ??
      225;
    const levels: FactoryLevel[] = rows.map((r) => ({
      lots: lotsForLogicLevel(logic, rows.indexOf(r), startLots, entryMultiplier, 10, r.lots),
      profit: tp,
      drop: r.drop,
    }));
    // recompute lots cleanly by index
    for (let li = 0; li < levels.length; li++) {
      levels[li]!.lots = lotsForLogicLevel(
        logic,
        li,
        startLots,
        entryMultiplier,
        10,
        rows[li]?.lots,
      );
      levels[li]!.profit = tp;
    }
    const n = Math.min(levels.length, martinMaxLevels(logic));
    const trimmed = levels.slice(0, n);
    const id = `param-${shortHash(`${logic}|${symbol}|${direction}|${startLots}|${entryMultiplier}|${i}|${opts.seed}`)}`;
    out.push({
      id,
      kind: "preset_param",
      label: `${symbol}-${direction}-${logic}-s${startLots}-m${entryMultiplier}-${id.slice(-6)}`,
      symbol,
      direction,
      dualDirection: false,
      runnable: true,
      levels: trimmed,
      bot: {
        logic,
        direction,
        dualDirection: false,
        startLots,
        entryCount: trimmed.length,
        entryMultiplier,
        takeProfitPct: tp,
        stopLossPct: sl,
        repeatEnabled: true,
        stopOnSl: true,
      },
      meta: { logic, startLots, entryMultiplier, source: "preset_param" },
    });
  }
  return out;
}

export function inventNovelCandidates(opts: {
  seed: number;
  count: number;
  symbols: string[];
  parents?: StrategyGenomeV1[];
}): FactoryCandidate[] {
  const rng = mulberry(opts.seed);
  const out: FactoryCandidate[] = [];
  for (let i = 0; i < opts.count; i++) {
    const seed = (opts.seed + i * 7919) >>> 0;
    const parent = opts.parents?.length ? pick(rng, opts.parents) : null;
    const genome = parent ? mutateLadderGenome(parent, seed) : inventLadderGenome(seed);
    const compiled = compileGenome(genome);
    const symbol = pick(rng, opts.symbols);
    const direction = compiled.bot.direction;
    const dual = compiled.bot.dualDirection;
    out.push({
      id: genome.id,
      kind: "novel_ladder",
      label: `${symbol}-${dual ? "DUAL" : direction}-N${compiled.levels.length}-tp${compiled.bot.takeProfitPct}-${genome.id.slice(-6)}`,
      symbol,
      direction,
      dualDirection: dual,
      runnable: true,
      levels: compiled.levels,
      bot: {
        logic: "custom",
        direction,
        dualDirection: dual,
        startLots: compiled.bot.startLots,
        entryCount: compiled.bot.entryCount,
        entryMultiplier: genome.lots.multiplier,
        takeProfitPct: compiled.bot.takeProfitPct,
        stopLossPct: compiled.bot.stopLossPct,
        repeatEnabled: compiled.bot.repeatEnabled,
        stopOnSl: compiled.bot.stopOnSl,
      },
      meta: {
        genome,
        spacingFamily: genome.spacingFamily,
        lotFamily: genome.lotFamily,
        source: "novel_ladder",
      },
    });
  }
  return out;
}

export function inventSketchCandidates(opts: {
  seed: number;
  count: number;
  symbols: string[];
}): FactoryCandidate[] {
  const rng = mulberry(opts.seed);
  const out: FactoryCandidate[] = [];
  for (let i = 0; i < opts.count; i++) {
    const sketch = inventMechanismSketch((opts.seed + i * 13) >>> 0);
    const symbol = pick(rng, opts.symbols);
    out.push({
      id: sketch.id,
      kind: "sketch",
      label: `${symbol}-SKETCH-${sketch.id.slice(-6)} · ${sketch.headline}`,
      symbol,
      direction: "SELL",
      dualDirection: false,
      runnable: false,
      levels: [],
      bot: {
        logic: "custom",
        direction: "SELL",
        dualDirection: false,
        startLots: 0.01,
        entryCount: 0,
        entryMultiplier: 1,
        takeProfitPct: 10,
        stopLossPct: 225,
        repeatEnabled: true,
        stopOnSl: true,
      },
      meta: { sketch, source: "sketch" },
    });
  }
  return out;
}

export function scaleLevelsToSeed(
  levels: FactoryLevel[],
  baseSeed = 1000,
  targetSeed: number,
): FactoryLevel[] {
  const scale = Math.max(0.01, targetSeed / Math.max(1, baseSeed));
  return levels.map((lv) => ({
    ...lv,
    lots: Math.max(0.01, Math.round(lv.lots * scale * 100) / 100),
  }));
}
