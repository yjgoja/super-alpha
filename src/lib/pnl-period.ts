import { addSeoulDays, dayKeySeoul } from "@/lib/day-key";

/** Home chart / period table always shows this many consecutive KST days. */
export const PNL_DAY_COUNT = 5;

export type DayPnl = { date: string; pnl: number; trades: number };

export type CumPnl = {
  date: string;
  pnl: number;
  dayPnl: number;
  trades: number;
};

/** Last `count` Seoul calendar day keys ending at `today` (inclusive), oldest → newest. */
export function lastKstDayKeys(
  today: string = dayKeySeoul(),
  count: number = PNL_DAY_COUNT,
): string[] {
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    keys.push(addSeoulDays(today, -i));
  }
  return keys;
}

/**
 * Merge sparse day rows into exactly `count` consecutive KST days.
 * Missing days become { pnl: 0, trades: 0 } so chart/table never drop zeros.
 */
export function padDailyPnl(
  rows: Iterable<{ date: string; pnl: number; trades: number }>,
  today: string = dayKeySeoul(),
  count: number = PNL_DAY_COUNT,
): DayPnl[] {
  const map = new Map<string, { pnl: number; trades: number }>();
  for (const r of rows) {
    map.set(r.date, { pnl: r.pnl, trades: r.trades });
  }
  return lastKstDayKeys(today, count).map((k) => {
    const v = map.get(k) || { pnl: 0, trades: 0 };
    return {
      date: k,
      pnl: Math.round(v.pnl * 100) / 100,
      trades: v.trades,
    };
  });
}

export function withCumulative(days: DayPnl[]): CumPnl[] {
  let running = 0;
  return days.map((d) => {
    running += d.pnl;
    return {
      date: d.date,
      pnl: Math.round(running * 100) / 100,
      dayPnl: d.pnl,
      trades: d.trades,
    };
  });
}
