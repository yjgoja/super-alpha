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
