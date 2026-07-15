/** Korea calendar day helpers for daily PnL / DailyStat bucketing. */
export const APP_TZ = "Asia/Seoul";

/** YYYY-MM-DD in Asia/Seoul for the given instant (default: now). */
export function dayKeySeoul(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: APP_TZ });
}

/** Instant when that Seoul calendar day starts (00:00 KST). */
export function seoulDayStartUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+09:00`);
}

/** Shift a Seoul YYYY-MM-DD by `delta` calendar days. */
export function addSeoulDays(dateStr: string, delta: number): string {
  const start = seoulDayStartUtc(dateStr);
  return dayKeySeoul(new Date(start.getTime() + delta * 86_400_000));
}
