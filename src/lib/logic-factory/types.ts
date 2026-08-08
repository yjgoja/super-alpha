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
  /** 그 달 체결 로트 합계 */
  lots: number;
  /** 그 달 리베이트($) — 손익에는 포함하지 않고 따로 본다 */
  rebateUsd: number;
};

/**
 * 시드별 요약 — 옛 보고서의 "시드별 요약" 표에 쓰던 것.
 * 월별 상세는 일부러 뺐다. 에폭 파일이 이미 65KB×6천개라 시드마다 월 배열을
 * 넣으면 산출물이 몇 배로 불어난다.
 */
export type SeedFact = {
  seed: number;
  medianMonthReturnPct: number;
  consistency: number;
  maxDrawdownPct: number;
  tpCount: number;
  slCount: number;
  tpUsd: number;
  slUsd: number;
  lotsTraded: number;
  rebateUsd: number;
  finalEquity: number;
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
  /** 체결 로트 합계 (최저 시드 기준) */
  lotsTraded: number;
  /** 리베이트($) — 손익에 더하지 않고 따로 본다 */
  rebateUsd: number;
  /** 강제청산(스톱아웃) 횟수. 0 이 아니면 실계좌에서 계좌가 날아간 것이다. */
  stoppedOutCount: number;
  /** 시드별 요약 (1000·2000·3000·5000·10000·30000) */
  seeds: SeedFact[];
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
  /** skip DB promote (still invent/sim/rank/persist files) */
  dryPromote: boolean;
};
