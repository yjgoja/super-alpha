/**
 * Zero Markets H8 session clock (broker EET/EEST).
 * Chart bars open at 00:00 / 08:00 / 16:00 server time — not KST open-burst.
 */

export const H8_BROKER_TZ = "Europe/Athens";

/** H8 bar open minutes-of-day (server wall clock) */
export const H8_OPEN_MINS = [0, 8 * 60, 16 * 60] as const;

export const H8_ENTRY_DELAY_MIN = 15;

export type BrokerClock = {
  minutesOfDay: number;
  ymd: string;
  hour: number;
  minute: number;
};

export function brokerParts(d: Date = new Date(), timeZone = H8_BROKER_TZ): BrokerClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  const minute = Number(parts.minute);
  return {
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    minutesOfDay: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Largest H8 open at or before this broker minute (00:00 is a valid open). */
export function currentH8OpenMin(minutesOfDay: number): number {
  let best: number = H8_OPEN_MINS[0]!;
  for (const m of H8_OPEN_MINS) {
    if (minutesOfDay >= m) best = m;
  }
  return best;
}

export function h8SessionKey(d: Date = new Date()): string {
  const { ymd, minutesOfDay } = brokerParts(d);
  return `${ymd}-${currentH8OpenMin(minutesOfDay)}`;
}

export function isH8OpenMinute(d: Date = new Date()): boolean {
  const { minutesOfDay } = brokerParts(d);
  return (H8_OPEN_MINS as readonly number[]).includes(minutesOfDay);
}

export function isH8EntryMinute(d: Date = new Date()): boolean {
  const { minutesOfDay } = brokerParts(d);
  return (H8_OPEN_MINS as readonly number[]).some((m) => minutesOfDay === m + H8_ENTRY_DELAY_MIN);
}

/** Minutes elapsed since current H8 open (0 .. ~479). */
export function minutesSinceH8Open(d: Date = new Date()): number {
  const { minutesOfDay } = brokerParts(d);
  return minutesOfDay - currentH8OpenMin(minutesOfDay);
}

/** True during open .. open+15m (ENTRY/DCA quiet for time logics). */
export function isInH8EntryQuiet(d: Date = new Date()): boolean {
  return minutesSinceH8Open(d) < H8_ENTRY_DELAY_MIN;
}

export function canH8Enter(d: Date = new Date()): boolean {
  return minutesSinceH8Open(d) >= H8_ENTRY_DELAY_MIN;
}

/** BUY if mid > barOpen, SELL if mid < barOpen, null if flat. */
export function h8DirectionFromOpen(
  mid: number,
  barOpen: number,
  eps = 1e-12,
): "BUY" | "SELL" | null {
  if (!(mid > 0) || !(barOpen > 0)) return null;
  if (mid > barOpen + eps) return "BUY";
  if (mid < barOpen - eps) return "SELL";
  return null;
}
