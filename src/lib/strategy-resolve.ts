import { prisma } from "./db";
import {
  applyBulkPayload,
  defaultEntryMultiplier,
  getTableLevels,
  getTableLeverage,
  isBulkLogic,
  levelsToDca,
  lotsForLogicLevel,
  type ResolvedStrategy,
  type StrategyPayload,
} from "./table-logics";

/** 계좌 오버라이드 반영 레벨 해석 (서버 전용) */
export async function resolveStrategyForAccount(
  accountId: string,
  logic: string,
  opts?: { entryMultiplier?: number; startLots?: number },
): Promise<ResolvedStrategy> {
  const row = await prisma.strategyLogic.findUnique({
    where: { accountId_logicId: { accountId, logicId: logic } },
  });
  const payload = (row?.payload || null) as StrategyPayload | null;
  const lev = payload?.leverageBase ?? getTableLeverage(logic);
  const startLots = Math.max(0.01, payload?.startLots ?? opts?.startLots ?? 0.01);

  if (payload?.mode === "levels" && payload.levels && payload.levels.length > 0) {
    const levels = levelsToDca(payload.levels, payload.takeProfitPct);
    return {
      levels,
      leverageBase: lev,
      startLots: levels[0]?.lots ?? startLots,
      takeProfitPct: payload.takeProfitPct ?? levels[0]?.profit ?? null,
      stopLossPct: payload.stopLossPct ?? null,
      mode: "levels",
      hasOverride: true,
    };
  }

  if (payload?.mode === "bulk" || (payload && isBulkLogic(logic))) {
    const levels = applyBulkPayload(logic, {
      mode: "bulk",
      startLots: payload.startLots ?? startLots,
      takeProfitPct: payload.takeProfitPct,
      stopLossPct: payload.stopLossPct,
      leverageBase: lev,
    });
    return {
      levels,
      leverageBase: lev,
      startLots: payload.startLots ?? startLots,
      takeProfitPct: payload.takeProfitPct ?? null,
      stopLossPct: payload.stopLossPct ?? null,
      mode: "bulk",
      hasOverride: true,
    };
  }

  const levels = getTableLevels(logic, opts?.entryMultiplier).map((lv, i) => ({
    ...lv,
    lots: lotsForLogicLevel(
      logic,
      i,
      startLots,
      opts?.entryMultiplier ?? defaultEntryMultiplier(logic),
      lv.size,
    ),
  }));

  return {
    levels,
    leverageBase: lev,
    startLots,
    takeProfitPct: null,
    stopLossPct: null,
    mode: "preset",
    hasOverride: false,
  };
}
