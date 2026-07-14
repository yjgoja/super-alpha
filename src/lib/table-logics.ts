import dca1000Json from "./presets/dca1000-levels.json";
import martin9Json from "./presets/martin9-levels.json";
import martin10Json from "./presets/martin10-levels.json";
import martin11Json from "./presets/martin11-levels.json";
import martin12Json from "./presets/martin12-levels.json";
import dubai313Json from "./presets/dubai313-levels.json";
import type { Dca1000Level } from "./dca1000";

type LevelsFile = { leverageBase?: number; levels: Dca1000Level[] };

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
  levels?: StrategyLevelRow[];
};

export type ResolvedStrategy = {
  levels: (Dca1000Level & { lots?: number })[];
  leverageBase: number;
  startLots: number;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  mode: "bulk" | "levels" | "preset";
  hasOverride: boolean;
};

function buildLevels(file: LevelsFile): Dca1000Level[] {
  const rows = file.levels || [];
  const first = rows[0] || { size: 10, profit: 20, drop: 10 };
  return [{ size: first.size, profit: first.profit, drop: 0 }, ...rows];
}

export const TABLE_LOGIC_IDS = [
  "dca_1000",
  "martin_9",
  "martin_10",
  "martin_11",
  "martin_12",
  "dubai_bruno_313",
  "custom",
] as const;

export type TableLogicId = (typeof TABLE_LOGIC_IDS)[number];

const TABLE_FILES: Record<Exclude<TableLogicId, "custom">, LevelsFile> = {
  dca_1000: dca1000Json as LevelsFile,
  martin_9: martin9Json as LevelsFile,
  martin_10: martin10Json as LevelsFile,
  martin_11: martin11Json as LevelsFile,
  martin_12: martin12Json as LevelsFile,
  dubai_bruno_313: dubai313Json as LevelsFile,
};

const LEVELS_CACHE: Partial<Record<string, Dca1000Level[]>> = {};

export function isTableLogic(logic: string): logic is TableLogicId {
  return (TABLE_LOGIC_IDS as readonly string[]).includes(logic);
}

export function isBulkLogic(logic: string) {
  return logic === "dca_1000" || logic === "dubai_bruno_313";
}

export function isMartinLogic(logic: string) {
  return logic === "custom" || /^martin_\d+$/i.test(logic);
}

export function isLevelsEditableLogic(logic: string) {
  return isMartinLogic(logic);
}

/** 마틴게일 9차 → 최대 9회차 (L0~L8) */
export function martinMaxLevels(logic: string): number {
  if (logic === "custom") return 12;
  const m = logic.match(/martin_(\d+)/i);
  if (!m) return 12;
  return Math.max(2, Math.min(30, Number(m[1])));
}

export function defaultEntryMultiplier(logic: string): number {
  return isMartinLogic(logic) && logic !== "custom" ? 2 : 1;
}

/**
 * 표 로직 회차 로트.
 * - explicitLots 있으면 그 값 사용
 * - DCA/두바이: size 비율 × startLots
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
  if (logic === "custom") {
    return Array.from({ length: 9 }, (_, i) => ({
      size: Math.round(10 * Math.pow(2, i) * 100) / 100,
      profit: 20,
      drop: i === 0 ? 0 : 10 * i,
    }));
  }
  const id = isTableLogic(logic) && logic !== "custom" ? logic : "dca_1000";
  if (!LEVELS_CACHE[id]) {
    LEVELS_CACHE[id] = buildLevels(TABLE_FILES[id as Exclude<TableLogicId, "custom">]);
  }
  const full = LEVELS_CACHE[id]!;
  if (isMartinLogic(id)) {
    const n = martinMaxLevels(id);
    return full.slice(0, n).map((lv, i) => ({
      ...lv,
      size: Math.round(10 * Math.pow(2, i) * 100) / 100,
    }));
  }
  return full;
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
  if (logic === "custom") return 20;
  const id = isTableLogic(logic) && logic !== "custom" ? logic : "dca_1000";
  return TABLE_FILES[id].leverageBase || 20;
}

export function tableLogicMeta(logic: string) {
  const levels = getTableLevels(logic);
  return {
    count: levels.length,
    dcaRows: Math.max(0, levels.length - 1),
    firstTpRoi: levels[0]?.profit ?? 20,
    lastDropRoi: levels[levels.length - 1]?.drop ?? 0,
  };
}

export function defaultEditorPayload(logic: string): StrategyPayload {
  if (isBulkLogic(logic)) {
    const meta = tableLogicMeta(logic);
    return {
      mode: "bulk",
      leverageBase: getTableLeverage(logic),
      startLots: 0.01,
      takeProfitPct: meta.firstTpRoi || 20,
      stopLossPct: 225,
    };
  }
  return {
    mode: "levels",
    leverageBase: getTableLeverage(logic),
    startLots: 0.01,
    takeProfitPct: 20,
    stopLossPct: 225,
    levels: presetToEditorRows(logic, 0.01, 2),
  };
}
