/** Logic factory shared types — discovery only until safe promote. */

export type FactoryKind = "preset_param" | "novel_ladder" | "sketch";

export type FactoryLevel = { lots: number; profit: number; drop: number };

export type FactoryBotKnobs = {
  logic: string;
  direction: "BUY" | "SELL";
  dualDirection: boolean;
  startLots: number;
  entryCount: number;
  entryMultiplier: number;
  takeProfitPct: number;
  stopLossPct: number;
  repeatEnabled: boolean;
  stopOnSl: boolean;
};

export type FactoryCandidate = {
  id: string;
  kind: FactoryKind;
  label: string;
  symbol: string;
  /** Primary side for bot unique key; DUAL → dualDirection true */
  direction: "BUY" | "SELL";
  dualDirection: boolean;
  runnable: boolean;
  /** levels payload for custom / override */
  levels: FactoryLevel[];
  bot: FactoryBotKnobs;
  /** optional DNA for novel / param provenance */
  meta: Record<string, unknown>;
};

export type MonthStat = {
  month: string; // YYYY-MM
  startEquity: number;
  endEquity: number;
  returnPct: number;
  tpCount: number;
  slCount: number;
  tpUsd: number;
  slUsd: number;
};

export type SimMetrics = {
  seed: number;
  finalEquity: number;
  totalReturnPct: number;
  /** median of monthly returnPct */
  medianMonthReturnPct: number;
  /** fraction of months with returnPct > 0 */
  consistency: number;
  maxDrawdownPct: number;
  tpCount: number;
  slCount: number;
  tpUsd: number;
  slUsd: number;
  months: MonthStat[];
  /** composite score used for ranking */
  score: number;
};

export type RankedCandidate = FactoryCandidate & {
  metrics: SimMetrics;
};

export type FactoryEpochResult = {
  runId: string;
  epoch: number;
  generation: number;
  tested: number;
  precise: number;
  elapsedMs: number;
  best: RankedCandidate | null;
  top: RankedCandidate[];
  outDir: string;
};

export type FactoryConfig = {
  runId: string;
  symbols: string[];
  seeds: number[];
  /** candidates per generation (param + novel) */
  generationSize: number;
  /** novel ladder fraction of generationSize */
  novelRatio: number;
  /** sketch fraction (non-runnable, not simulated) */
  sketchRatio: number;
  /** keep top K as mutation parents */
  eliteCount: number;
  /** promote if median month return >= this */
  minMedianMonthPct: number;
  /** promote if consistency >= this */
  minConsistency: number;
  /** promote if score >= this */
  minScore: number;
  maxPromoteLots: number;
  barStride: number;
  continuous: boolean;
  sleepMs: number;
  autoPromote: boolean;
  /** max generations in one process (0 = infinite when continuous) */
  maxGenerations: number;
};
