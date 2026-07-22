import martin9Json from "./presets/martin9-levels.json";
import dubai313Json from "./presets/dubai313-levels.json";
import type { Dca1000Level } from "./dca1000";
import { DCA1000_DEFAULT_SL_ROI } from "./dca1000";
import { normalizeLogicId } from "./strategies";

type LevelsFile = { leverageBase?: number; levels: Dca1000Level[] };

/** MT5 1:500 XAU 기준 차트 방어폭 프리셋 (익절 ROI 20% 고정) */
export type Martin9DefensePreset = {
  chartPct: number;
  /** 기본 표 drop × scale */
  dropScale: number;
  stopLossPct: number;
  takeProfitPct: number;
};

export const MARTIN9_DEFENSE: Record<string, Martin9DefensePreset> = {
  martin_9_65: {
    chartPct: 6.5,
    dropScale: 9.741,
    stopLossPct: 2191.7,
    takeProfitPct: 20,
  },
  martin_9_35: {
    chartPct: 3.5,
    dropScale: 5.201,
    stopLossPct: 1170.3,
    takeProfitPct: 20,
  },
  martin_9_068: {
    chartPct: 0.68,
    dropScale: 1,
    stopLossPct: 225,
    takeProfitPct: 20,
  },
};

export function getMartin9Defense(logic: string): Martin9DefensePreset | null {
  const id = normalizeLogicId(logic);
  return MARTIN9_DEFENSE[id] ?? null;
}

export function isMartin9Logic(logic: string) {
  const id = normalizeLogicId(logic);
  return id === "martin_9" || id.startsWith("martin_9_");
}

/** 에디터·엔진용 회차 (lots 명시 가능) */
export type StrategyLevelRow = {
  lots: number;
  profit: number;
  drop: number;
};

export type StrategyPayload = {
  mode: "bulk" | "levels";
  leverageBase?: number;
  startLots?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  /** 고정 익절$ (우선). 없으면 takeProfitPct×시작로트증거금 */
  takeProfitUsd?: number;
  /** 고정 손절$ (우선). 없으면 stopLossPct×시작로트증거금 */
  stopLossUsd?: number;
  levels?: StrategyLevelRow[];
};

export type ResolvedStrategy = {
  levels: (Dca1000Level & { lots?: number })[];
  leverageBase: number;
  startLots: number;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  takeProfitUsd: number | null;
  stopLossUsd: number | null;
  mode: "bulk" | "levels" | "preset";
  hasOverride: boolean;
};

function buildLevels(file: LevelsFile): Dca1000Level[] {
  const rows = file.levels || [];
  const first = rows[0] || { size: 10, profit: 20, drop: 10 };
  return [{ size: first.size, profit: first.profit, drop: 0 }, ...rows];
}

export const TABLE_LOGIC_IDS = [
  "martin_9_65",
  "martin_9_35",
  "martin_9_068",
  "dubai_bruno_313",
  "custom",
] as const;

export type TableLogicId = (typeof TABLE_LOGIC_IDS)[number];

const TABLE_FILES: Record<"martin_9" | "dubai_bruno_313", LevelsFile> = {
  martin_9: martin9Json as LevelsFile,
  dubai_bruno_313: dubai313Json as LevelsFile,
};

const LEVELS_CACHE: Partial<Record<string, Dca1000Level[]>> = {};

export function isTableLogic(logic: string): logic is TableLogicId {
  const id = normalizeLogicId(logic);
  return (TABLE_LOGIC_IDS as readonly string[]).includes(id);
}

export function isBulkLogic(logic: string) {
  return normalizeLogicId(logic) === "dubai_bruno_313";
}

export function isMartinLogic(logic: string) {
  const id = normalizeLogicId(logic);
  return id === "custom" || isMartin9Logic(id) || /^martin_\d+$/i.test(id);
}

export function isLevelsEditableLogic(logic: string) {
  return isMartinLogic(logic);
}

/** 마틴게일 9차 → 최대 9회차 (L0~L8) */
export function martinMaxLevels(logic: string): number {
  if (logic === "custom") return 12;
  if (isMartin9Logic(logic)) return 9;
  const m = logic.match(/martin_(\d+)/i);
  if (!m) return 12;
  return Math.max(2, Math.min(30, Number(m[1])));
}

export function defaultEntryMultiplier(logic: string): number {
  return isMartinLogic(logic) && normalizeLogicId(logic) !== "custom" ? 2 : 1;
}

function roundDrop(n: number) {
  if (n <= 0) return 0;
  if (n < 10) return Math.round(n * 10) / 10;
  return Math.round(n);
}

function tableFileKey(logic: string): "martin_9" | "dubai_bruno_313" {
  const id = normalizeLogicId(logic);
  if (isMartin9Logic(id)) return "martin_9";
  if (id === "dubai_bruno_313") return "dubai_bruno_313";
  return "dubai_bruno_313";
}

/**
 * 표 로직 회차 로트.
 * - explicitLots 있으면 그 값 사용
 * - DCA/313차: size 비율 × startLots
 * - 마틴: startLots × 배수^회차
 */
export function lotsForLogicLevel(
  logic: string,
  levelIndex: number,
  startLots: number,
  entryMultiplier: number,
  tableSize = 10,
  explicitLots?: number | null,
) {
  if (explicitLots != null && explicitLots > 0) {
    return Math.max(0.01, Math.round(explicitLots * 100) / 100);
  }
  const base = Math.max(0.01, startLots);
  if (isMartinLogic(logic) && logic !== "custom") {
    const mult = Math.max(1.01, entryMultiplier || 2);
    const raw = base * Math.pow(mult, Math.max(0, levelIndex));
    return Math.max(0.01, Math.round(raw * 100) / 100);
  }
  if (logic === "custom") {
    return base;
  }
  const raw = (tableSize / 10) * base;
  return Math.max(0.01, Math.round(raw * 100) / 100);
}

/** 마틴 미리보기용 회차별 로트 목록 */
export function previewMartinLots(startLots: number, multiplier: number, count: number) {
  const n = Math.max(1, Math.min(30, count));
  const mult = Math.max(1.01, multiplier || 2);
  const base = Math.max(0.01, startLots);
  return Array.from({ length: n }, (_, i) => ({
    level: i,
    lots: Math.max(0.01, Math.round(base * Math.pow(mult, i) * 100) / 100),
  }));
}

function presetFileLevels(logic: string): Dca1000Level[] {
  const normalized = normalizeLogicId(logic);
  if (normalized === "custom") {
    return Array.from({ length: 9 }, (_, i) => ({
      size: Math.round(10 * Math.pow(2, i) * 100) / 100,
      profit: 20,
      drop: i === 0 ? 0 : 10 * i,
    }));
  }

  const fileKey = tableFileKey(normalized);
  const cacheKey = isMartin9Logic(normalized) ? normalized : fileKey;
  if (!LEVELS_CACHE[cacheKey]) {
    const built = buildLevels(TABLE_FILES[fileKey]);
    if (isMartin9Logic(normalized)) {
      const defense = getMartin9Defense(normalized);
      const scale = defense?.dropScale ?? 1;
      const tp = defense?.takeProfitPct ?? 20;
      const n = martinMaxLevels(normalized);
      LEVELS_CACHE[cacheKey] = built.slice(0, n).map((lv, i) => ({
        size: Math.round(10 * Math.pow(2, i) * 100) / 100,
        profit: tp,
        drop: i === 0 ? 0 : roundDrop(lv.drop * scale),
      }));
    } else {
      LEVELS_CACHE[cacheKey] = built;
    }
  }
  return LEVELS_CACHE[cacheKey]!;
}

export function getTableLevels(logic: string, entryMultiplier?: number): Dca1000Level[] {
  const levels = presetFileLevels(logic);
  if (isMartinLogic(logic) && logic !== "custom" && entryMultiplier != null) {
    const mult = Math.max(1.01, entryMultiplier);
    return levels.map((lv, i) => ({
      ...lv,
      size: Math.round(10 * Math.pow(mult, i) * 100) / 100,
    }));
  }
  return levels;
}

/** 프리셋 → 에디터용 회차 rows */
export function presetToEditorRows(logic: string, startLots = 0.01, entryMultiplier = 2): StrategyLevelRow[] {
  const levels = getTableLevels(logic, entryMultiplier);
  const base = Math.max(0.01, startLots);
  return levels.map((lv, i) => ({
    lots: lotsForLogicLevel(logic, i, base, entryMultiplier, lv.size),
    profit: lv.profit,
    drop: i === 0 ? 0 : lv.drop,
  }));
}

export function levelsToDca(
  rows: StrategyLevelRow[],
  takeProfitPct?: number,
): (Dca1000Level & { lots?: number })[] {
  const baseLots = Math.max(0.01, rows[0]?.lots ?? 0.01);
  return rows.map((r, i) => {
    const lots = Math.max(0.01, r.lots);
    const size = Math.round((lots / baseLots) * 10 * 100) / 100;
    return {
      size: size > 0 ? size : 10,
      profit: takeProfitPct != null && takeProfitPct > 0 ? takeProfitPct : r.profit,
      drop: i === 0 ? 0 : r.drop,
      lots,
    };
  });
}

export function applyBulkPayload(
  logic: string,
  payload: StrategyPayload,
): (Dca1000Level & { lots?: number })[] {
  const base = presetFileLevels(logic);
  const startLots = Math.max(0.01, payload.startLots ?? 0.01);
  const tp = payload.takeProfitPct;
  return base.map((lv) => ({
    ...lv,
    size: 10,
    profit: tp != null && tp > 0 ? tp : lv.profit,
    lots: startLots,
  }));
}

export function getTableLeverage(logic: string): number {
  const normalized = normalizeLogicId(logic);
  if (normalized === "custom") return 20;
  return TABLE_FILES[tableFileKey(normalized)].leverageBase || 20;
}

export function tableLogicMeta(logic: string) {
  const levels = getTableLevels(logic);
  const defense = getMartin9Defense(logic);
  return {
    count: levels.length,
    dcaRows: Math.max(0, levels.length - 1),
    firstTpRoi: levels[0]?.profit ?? defense?.takeProfitPct ?? 20,
    lastDropRoi: levels[levels.length - 1]?.drop ?? 0,
    chartDefensePct: defense?.chartPct ?? null,
    stopLossPct: defense?.stopLossPct ?? null,
  };
}

export function defaultEditorPayload(logic: string): StrategyPayload {
  const defense = getMartin9Defense(logic);
  if (isBulkLogic(logic)) {
    const meta = tableLogicMeta(logic);
    return {
      mode: "bulk",
      leverageBase: getTableLeverage(logic),
      startLots: 0.01,
      takeProfitPct: meta.firstTpRoi || 20,
      stopLossPct: DCA1000_DEFAULT_SL_ROI,
      takeProfitUsd: 0,
      stopLossUsd: 0,
    };
  }
  return {
    mode: "levels",
    leverageBase: getTableLeverage(logic),
    startLots: 0.01,
    takeProfitPct: defense?.takeProfitPct ?? 20,
    stopLossPct: defense?.stopLossPct ?? DCA1000_DEFAULT_SL_ROI,
    takeProfitUsd: 0,
    stopLossUsd: 0,
    levels: presetToEditorRows(logic, 0.01, 2),
  };
}
