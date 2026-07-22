import { prisma } from "./db";
import { normalizeLogicId } from "./strategies";
import {
  applyBulkPayload,
  defaultEntryMultiplier,
  getMartin9Defense,
  getTableLevels,
  getTableLeverage,
  isBulkLogic,
  levelsToDca,
  lotsForLogicLevel,
  type ResolvedStrategy,
  type StrategyPayload,
} from "./table-logics";
import type { Prisma } from "@prisma/client";

/**
 * 알파 지속(두바이) 정상 복구: 잘못된 levels[]로 회차 TP가 평탄화된
 * 계좌 오버라이드를 bulk(로트·손절만)로 고쳐 정상 테이블(20→25)이 다시 쓰이게 한다.
 */
export async function healDubaiBrunoOverride(accountId: string): Promise<boolean> {
  const logicId = "dubai_bruno_313";
  const row = await prisma.strategyLogic.findUnique({
    where: { accountId_logicId: { accountId, logicId } },
  });
  if (!row) return false;
  const prev = (row.payload || {}) as StrategyPayload & Record<string, unknown>;
  const levels = Array.isArray(prev.levels) ? prev.levels : null;
  if (prev.mode !== "levels" && !levels) return false;

  const next: StrategyPayload = {
    mode: "bulk",
    leverageBase: prev.leverageBase ?? getTableLeverage(logicId),
    startLots: Math.max(0.01, Number(prev.startLots) || 0.01),
    stopLossPct: prev.stopLossPct != null ? Number(prev.stopLossPct) : 225,
    takeProfitUsd: prev.takeProfitUsd != null ? Number(prev.takeProfitUsd) : undefined,
    stopLossUsd: prev.stopLossUsd != null ? Number(prev.stopLossUsd) : undefined,
  };

  await prisma.strategyLogic.update({
    where: { id: row.id },
    data: { payload: next as Prisma.InputJsonValue },
  });
  return true;
}

/** 계좌 오버라이드 반영 레벨 해석 (서버 전용) */
export async function resolveStrategyForAccount(
  accountId: string,
  logic: string,
  opts?: { entryMultiplier?: number; startLots?: number },
): Promise<ResolvedStrategy> {
  const logicId = normalizeLogicId(logic);
  if (isBulkLogic(logicId)) {
    await healDubaiBrunoOverride(accountId);
  }
  const row = await prisma.strategyLogic.findUnique({
    where: { accountId_logicId: { accountId, logicId } },
  });
  const payload = (row?.payload || null) as StrategyPayload | null;
  const lev = payload?.leverageBase ?? getTableLeverage(logicId);
  const startLots = Math.max(0.01, payload?.startLots ?? opts?.startLots ?? 0.01);

  // 알파 지속: 항상 표 기준 회차 TP 유지 (levels 오버라이드 비활성)
  if (isBulkLogic(logicId)) {
    if (payload) {
      const levels = applyBulkPayload(logicId, {
        mode: "bulk",
        startLots: payload.startLots ?? startLots,
        stopLossPct: payload.stopLossPct,
        takeProfitUsd: payload.takeProfitUsd,
        stopLossUsd: payload.stopLossUsd,
        leverageBase: lev,
      });
      return {
        levels,
        leverageBase: lev,
        startLots: payload.startLots ?? startLots,
        takeProfitPct: levels[0]?.profit ?? null,
        stopLossPct: payload.stopLossPct ?? null,
        takeProfitUsd: payload.takeProfitUsd ?? null,
        stopLossUsd: payload.stopLossUsd ?? null,
        mode: "bulk",
        hasOverride: true,
      };
    }
  } else if (payload?.mode === "levels" && payload.levels && payload.levels.length > 0) {
    const levels = levelsToDca(payload.levels, payload.takeProfitPct);
    return {
      levels,
      leverageBase: lev,
      startLots: levels[0]?.lots ?? startLots,
      takeProfitPct: payload.takeProfitPct ?? levels[0]?.profit ?? null,
      stopLossPct: payload.stopLossPct ?? null,
      takeProfitUsd: payload.takeProfitUsd ?? null,
      stopLossUsd: payload.stopLossUsd ?? null,
      mode: "levels",
      hasOverride: true,
    };
  } else if (payload?.mode === "bulk") {
    const levels = applyBulkPayload(logicId, {
      mode: "bulk",
      startLots: payload.startLots ?? startLots,
      takeProfitPct: payload.takeProfitPct,
      stopLossPct: payload.stopLossPct,
      takeProfitUsd: payload.takeProfitUsd,
      stopLossUsd: payload.stopLossUsd,
      leverageBase: lev,
    });
    return {
      levels,
      leverageBase: lev,
      startLots: payload.startLots ?? startLots,
      takeProfitPct: payload.takeProfitPct ?? null,
      stopLossPct: payload.stopLossPct ?? null,
      takeProfitUsd: payload.takeProfitUsd ?? null,
      stopLossUsd: payload.stopLossUsd ?? null,
      mode: "bulk",
      hasOverride: true,
    };
  }

  const levels = getTableLevels(logicId, opts?.entryMultiplier).map((lv, i) => ({
    ...lv,
    lots: lotsForLogicLevel(
      logicId,
      i,
      startLots,
      opts?.entryMultiplier ?? defaultEntryMultiplier(logicId),
      lv.size,
    ),
  }));

  return {
    levels,
    leverageBase: lev,
    startLots,
    takeProfitPct: getMartin9Defense(logicId)?.takeProfitPct ?? null,
    stopLossPct: getMartin9Defense(logicId)?.stopLossPct ?? null,
    takeProfitUsd: null,
    stopLossUsd: null,
    mode: "preset",
    hasOverride: false,
  };
}
