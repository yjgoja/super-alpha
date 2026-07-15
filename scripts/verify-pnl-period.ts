/**
 * Local check: padDailyPnl always returns 5 consecutive KST days with zeros.
 * Run: npx tsx scripts/verify-pnl-period.ts
 */
import { dayKeySeoul } from "../src/lib/day-key";
import { lastKstDayKeys, padDailyPnl, withCumulative } from "../src/lib/pnl-period";

const today = dayKeySeoul();
const expected = lastKstDayKeys(today, 5);

// Simulate prod bug: only Jul 15–16 have fills
const sparse = [
  { date: expected[3], pnl: 12.5, trades: 2 },
  { date: expected[4], pnl: -3.1, trades: 1 },
];

const days = padDailyPnl(sparse, today);
const cum = withCumulative(days);

if (days.length !== 5) {
  console.error("FAIL: expected 5 days, got", days.length);
  process.exit(1);
}
if (days.map((d) => d.date).join(",") !== expected.join(",")) {
  console.error("FAIL: dates", days.map((d) => d.date), "expected", expected);
  process.exit(1);
}
for (let i = 0; i < 3; i++) {
  if (days[i].pnl !== 0 || days[i].trades !== 0) {
    console.error("FAIL: early days must be zero", days[i]);
    process.exit(1);
  }
}
if (cum.length !== 5) {
  console.error("FAIL: cumulative length", cum.length);
  process.exit(1);
}

console.log("OK last 5 KST days:", days.map((d) => `${d.date}=${d.pnl}`).join(" | "));
console.log("today:", today);
