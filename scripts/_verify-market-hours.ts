/**
 * Market-hours helpers smoke test (no DB).
 *   npx tsx scripts/_verify-market-hours.ts
 */
import assert from "assert";
import {
  isInOpenBurstQuietPeriod,
  isMarketSessionBlockedError,
  OPEN_BURST_WINDOWS_KST,
  seoulParts,
} from "../src/lib/market-hours";

assert.equal(OPEN_BURST_WINDOWS_KST.length, 3);
assert.ok(OPEN_BURST_WINDOWS_KST.some((w) => w.label === "09:00"));
assert.ok(OPEN_BURST_WINDOWS_KST.some((w) => w.label === "17:00"));
assert.ok(OPEN_BURST_WINDOWS_KST.some((w) => w.label === "22:30"));

// Fixed KST instants via +09:00
function atKst(h: number, m: number) {
  const day = "2026-07-25";
  return new Date(
    `${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`,
  );
}

assert.equal(seoulParts(atKst(9, 0)).minutesOfDay, 9 * 60);
assert.equal(isInOpenBurstQuietPeriod(atKst(9, 0)).active, true);
assert.equal(isInOpenBurstQuietPeriod(atKst(9, 14)).active, true);
assert.equal(isInOpenBurstQuietPeriod(atKst(9, 15)).active, false);
assert.equal(isInOpenBurstQuietPeriod(atKst(17, 0)).active, true);
assert.equal(isInOpenBurstQuietPeriod(atKst(17, 15)).active, false);
assert.equal(isInOpenBurstQuietPeriod(atKst(22, 30)).active, true);
assert.equal(isInOpenBurstQuietPeriod(atKst(22, 44)).active, true);
assert.equal(isInOpenBurstQuietPeriod(atKst(22, 45)).active, false);
assert.equal(isInOpenBurstQuietPeriod(atKst(12, 0)).active, false);

assert.ok(isMarketSessionBlockedError("Market is closed"));
assert.ok(isMarketSessionBlockedError("Trade is disabled"));
assert.ok(isMarketSessionBlockedError("현재 해당 종목 거래가 불가능합니다(장 마감 등)."));
assert.ok(!isMarketSessionBlockedError("insufficient margin"));

console.log("OK verify-market-hours");
