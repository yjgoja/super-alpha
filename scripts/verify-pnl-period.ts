/**
 * Local check: padDailyPnl always returns 7 consecutive KST days with zeros.
 * Run: npx tsx scripts/verify-pnl-period.ts
 */
import { dayKeySeoul } from "../src/lib/day-key";
import {
  lastKstDayKeys,
  padDailyPnl,
  withCumulative,
  PNL_DAY_COUNT,
} from "../src/lib/pnl-period";

const today = dayKeySeoul();
const expected = lastKstDayKeys(today, PNL_DAY_COUNT);

// Simulate sparse fills on last two days
const sparse = [
  { date: expected[PNL_DAY_COUNT - 2], pnl: 12.5, trades: 2 },
  { date: expected[PNL_DAY_COUNT - 1], pnl: -3.1, trades: 1 },
];

const days = padDailyPnl(sparse, today);
const cum = withCumulative(days);

if (days.length !== PNL_DAY_COUNT) {
  console.error("FAIL: expected", PNL_DAY_COUNT, "days, got", days.length);
  process.exit(1);
}
if (days.map((d) => d.date).join(",") !== expected.join(",")) {
  console.error("FAIL: dates", days.map((d) => d.date), "expected", expected);
  process.exit(1);
}
for (let i = 0; i < PNL_DAY_COUNT - 2; i++) {
  if (days[i].pnl !== 0 || days[i].trades !== 0) {
    console.error("FAIL: early days must be zero", days[i]);
    process.exit(1);
  }
}
if (cum.length !== PNL_DAY_COUNT) {
  console.error("FAIL: cumulative length", cum.length);
  process.exit(1);
}

console.log(
  `OK last ${PNL_DAY_COUNT} KST days:`,
  days.map((d) => `${d.date}=${d.pnl}`).join(" | "),
);
console.log("today:", today);
