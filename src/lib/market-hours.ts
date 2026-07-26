import { APP_TZ } from "./day-key";

/** Seoul wall-clock parts for an instant. */
export function seoulParts(d: Date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  const minute = Number(parts.minute);
  return {
    weekday: parts.weekday || "",
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    minutesOfDay: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
  };
}

/**
 * Market open burst windows (KST) — first 15 minutes after each open:
 * 09:00, 17:00, 22:30
 */
export const OPEN_BURST_WINDOWS_KST: ReadonlyArray<{ startMin: number; label: string }> = [
  { startMin: 9 * 60, label: "09:00" },
  { startMin: 17 * 60, label: "17:00" },
  { startMin: 22 * 60 + 30, label: "22:30" },
];

export const OPEN_BURST_BLOCK_MINUTES = 15;

/** True when now is inside an open-burst quiet window (KST). */
export function isInOpenBurstQuietPeriod(d: Date = new Date()): {
  active: boolean;
  label: string | null;
  endsInMin: number | null;
} {
  const { minutesOfDay } = seoulParts(d);
  for (const w of OPEN_BURST_WINDOWS_KST) {
    const end = w.startMin + OPEN_BURST_BLOCK_MINUTES;
    if (minutesOfDay >= w.startMin && minutesOfDay < end) {
      return {
        active: true,
        label: w.label,
        endsInMin: end - minutesOfDay,
      };
    }
  }
  return { active: false, label: null, endsInMin: null };
}

/** Friday UTC hour when FX/CFD weekly session ends (default 21). */
export function fxFridayCloseUtcHour() {
  const n = Number(process.env.FX_SESSION_CLOSE_UTC_HOUR ?? 21);
  return Number.isFinite(n) ? Math.min(23, Math.max(0, Math.floor(n))) : 21;
}

/** Sunday UTC hour when FX/CFD weekly session reopens (default 22). */
export function fxSundayOpenUtcHour() {
  const n = Number(process.env.FX_SESSION_OPEN_UTC_HOUR ?? 22);
  return Number.isFinite(n) ? Math.min(23, Math.max(0, Math.floor(n))) : 22;
}

export type FxSessionPhase =
  | "open"
  | "friday_closed"
  | "saturday_closed"
  | "sunday_preopen";

export type FxMarketSession = {
  /** 장중 = 시장가 주문·ROI soft TP/SL 허용 */
  open: boolean;
  /** 폐장 = 신규·물타기·시장가 청산 금지, 브로커 TP/SL만 */
  closed: boolean;
  phase: FxSessionPhase;
  reason: string;
};

/**
 * ZeroMarkets / 일반 FX·XAU 주간 세션 (UTC).
 * - 장중: Sun openHour ~ Fri closeHour
 * - 폐장: Fri closeHour → Sat 종일 → Sun openHour 직전
 *
 * 브로커 공휴일/일시 차단은 isMarketSessionBlockedError 로 사후 확인.
 */
export function getFxMarketSession(d: Date = new Date()): FxMarketSession {
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  const h = d.getUTCHours();
  const closeH = fxFridayCloseUtcHour();
  const openH = fxSundayOpenUtcHour();

  if (day === 6) {
    return {
      open: false,
      closed: true,
      phase: "saturday_closed",
      reason: "폐장(토요일)",
    };
  }
  if (day === 5 && h >= closeH) {
    return {
      open: false,
      closed: true,
      phase: "friday_closed",
      reason: `폐장(금요일 UTC ${closeH}:00~)`,
    };
  }
  if (day === 0 && h < openH) {
    return {
      open: false,
      closed: true,
      phase: "sunday_preopen",
      reason: `폐장(일요일 UTC ${openH}:00 개장 전)`,
    };
  }
  return {
    open: true,
    closed: false,
    phase: "open",
    reason: "장중",
  };
}

/** 장중 — 시장가 ENTRY/DCA/ROI soft TP·SL 가능 */
export function isFxMarketOpen(d: Date = new Date()): boolean {
  return getFxMarketSession(d).open;
}

/** 폐장 — 신규 리스크·시장가 청산 금지 */
export function isFxMarketClosed(d: Date = new Date()): boolean {
  return getFxMarketSession(d).closed;
}

/** @deprecated use isFxMarketClosed */
export function isWeeklyMarketClosed(d: Date = new Date()): boolean {
  return isFxMarketClosed(d);
}

/** MetaAPI / broker errors that mean market session cannot trade (close/entry). */
export function isMarketSessionBlockedError(msg: unknown): boolean {
  const text = typeof msg === "string" ? msg : msg == null ? "" : String(msg);
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("market is closed") ||
    lower.includes("trade is disabled") ||
    lower.includes("trade_retcode_market_closed") ||
    lower.includes("trade_retcode_close_only") ||
    lower.includes("market closed") ||
    lower.includes("session closed") ||
    lower.includes("trading disabled") ||
    lower.includes("not allowed for trading") ||
    text.includes("장 마감") ||
    text.includes("거래가 불가능") ||
    text.includes("거래 불가")
  );
}

/** Soft-close / entry backoff reasons that mean "do not spend trade credits". */
export function isSessionTradeBackoffReason(reason: string): boolean {
  return /market_closed|weekly_closed|session_closed|fx_closed|폐장/.test(
    reason || "",
  );
}
