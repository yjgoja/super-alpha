/**
 * Client-safe strategy labels & API redaction.
 * Names show chart defense % only — no drop/lot ladders.
 */

import { LOGIC_OPTIONS, normalizeLogicId, type LogicId } from "./strategies";

/** User-facing names — 로직명 + 차트 방어폭% */
export const PUBLIC_LOGIC_OPTIONS = [
  {
    id: "martin_9_068" as const,
    name: "알파 스피드 로직 - 0.68%",
    desc: "회전이 빠른 스피드 프리셋",
  },
  {
    id: "martin_9_091" as const,
    name: "알파 스피드 2배 - 0.91%",
    desc: "스피드 물타기 2배 늦은 프리셋",
  },
  {
    id: "martin_9_113" as const,
    name: "알파 스피드 3배 - 1.13%",
    desc: "스피드 물타기 3배 늦은 프리셋",
  },
  {
    id: "martin_9_35" as const,
    name: "알파 안정 로직 - 3.5%",
    desc: "안정 우선 프리셋",
  },
  {
    id: "martin_9_65" as const,
    name: "알파 코어 로직 - 6.5%",
    desc: "균형형 코어 프리셋",
  },
  {
    id: "dubai_bruno_313" as const,
    name: "알파 지속 로직 - 2.35%",
    desc: "회차가 깊은 지속형 프리셋",
  },
  {
    id: "martin_9_068_time" as const,
    name: "알파 스피드 타임 로직 - 0.68%",
    desc: "8시간봉 방향 + 스피드",
  },
  {
    id: "martin_9_35_time" as const,
    name: "알파 안정 타임 로직 - 3.5%",
    desc: "8시간봉 방향 + 안정",
  },
  {
    id: "custom" as const,
    name: "커스텀",
    desc: "관리자·고급 설정 전용",
  },
] as const;

export function publicLogicLabel(id: string) {
  const n = normalizeLogicId(id);
  return PUBLIC_LOGIC_OPTIONS.find((l) => l.id === n)?.name || "전략 프리셋";
}

/** H8 세션 방향 로직 (스피드/안정 타임) */
export function isPublicTimeLogic(id: string) {
  const n = normalizeLogicId(id);
  return n === "martin_9_068_time" || n === "martin_9_35_time";
}

/** Test-only roulette/kelly stay in engine; not listed in PUBLIC_LOGIC_OPTIONS */
export function publicLogicOptions() {
  return PUBLIC_LOGIC_OPTIONS.filter((l) => l.id !== "custom");
}

/** Strip SymbolBot fields that reveal margin ROI / ladder math / TP-SL $ */
export function redactSymbolBot<T extends Record<string, unknown>>(bot: T) {
  const {
    takeProfitPct: _tp,
    stopLossPct: _sl,
    takeProfitUsd: _tpUsd,
    stopLossUsd: _slUsd,
    entryIntervalPct: _eip,
    entryMultiplier: _em,
    entryCount: _ec,
    stopLossEnabled: _sle,
    ...safe
  } = bot as T & {
    takeProfitPct?: unknown;
    stopLossPct?: unknown;
    takeProfitUsd?: unknown;
    stopLossUsd?: unknown;
    entryIntervalPct?: unknown;
    entryMultiplier?: unknown;
    entryCount?: unknown;
    stopLossEnabled?: unknown;
  };
  return {
    ...safe,
    logic: normalizeLogicId(String(bot.logic ?? "")),
    logicLabel: publicLogicLabel(String(bot.logic ?? "")),
  };
}

export function redactFillNote(note: string | null | undefined) {
  if (!note) return null;
  // Engine notes often embed roi=/drop=/dcaROI=
  if (/roi|drop|dca|profit|margin|%|레벨|L\d/i.test(note)) {
    return "체결";
  }
  return note;
}

export type PublicStrategySummary = {
  logicId: string;
  name: string;
  desc: string;
  levelCount: number;
  startLots: number;
  takeProfitUsd: number;
  stopLossUsd: number;
  hasOverride: boolean;
  /** presets are locked; only custom may edit structure (admin) */
  locked: boolean;
};

export function isPresetLogicId(id: string): boolean {
  const n = normalizeLogicId(id) as LogicId | string;
  return n !== "custom" && LOGIC_OPTIONS.some((l) => l.id === n);
}
