/**
 * Client-safe strategy labels & API redaction.
 * Never put drop/profit/ROI tables or defense % in these exports.
 */

import { LOGIC_OPTIONS, normalizeLogicId, type LogicId } from "./strategies";

/** User-facing names — no ROI%, defense chart%, drop, lot ladders */
export const PUBLIC_LOGIC_OPTIONS = [
  {
    id: "martin_9_068" as const,
    name: "알파 스피드 로직",
    desc: "회전이 빠른 스피드 프리셋",
  },
  {
    id: "martin_9_35" as const,
    name: "알파 안정 로직",
    desc: "안정 우선 프리셋",
  },
  {
    id: "martin_9_65" as const,
    name: "알파 코어 로직",
    desc: "균형형 코어 프리셋",
  },
  {
    id: "dubai_bruno_313" as const,
    name: "알파 지속 로직",
    desc: "회차가 깊은 지속형 프리셋",
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

export function publicLogicOptions() {
  // Hide custom from normal picker unless already selected server-side
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
