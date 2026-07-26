/**
 * Market-hours helpers smoke test (no DB).
 *   npx tsx scripts/_verify-market-hours.ts
 */
import assert from "assert";
import {
  getFxMarketSession,
  isFxMarketClosed,
  isFxMarketOpen,
  isInOpenBurstQuietPeriod,
  isMarketSessionBlockedError,
  isSessionTradeBackoffReason,
  isWeeklyMarketClosed,
  OPEN_BURST_WINDOWS_KST,
  seoulParts,
} from "../src/lib/market-hours";

assert.equal(OPEN_BURST_WINDOWS_KST.length, 3);
assert.ok(OPEN_BURST_WINDOWS_KST.some((w) => w.label === "09:00"));
assert.ok(OPEN_BURST_WINDOWS_KST.some((w) => w.label === "17:00"));
assert.ok(OPEN_BURST_WINDOWS_KST.some((w) => w.label === "22:30"));

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

assert.ok(isSessionTradeBackoffReason("fx_closed_await_broker_tp"));
assert.ok(isSessionTradeBackoffReason("market_closed_entry"));
assert.ok(!isSessionTradeBackoffReason("broker_tp_armed"));

// 장중 / 폐장 명확 구분 (UTC)
const friOpen = new Date("2026-07-24T20:59:00.000Z");
const friClosed = new Date("2026-07-24T21:00:00.000Z");
const sat = new Date("2026-07-25T12:00:00.000Z");
const sunPre = new Date("2026-07-26T21:59:00.000Z");
const sunOpen = new Date("2026-07-26T22:00:00.000Z");
const mon = new Date("2026-07-27T10:00:00.000Z");

assert.equal(isFxMarketOpen(friOpen), true);
assert.equal(isFxMarketClosed(friOpen), false);
assert.equal(getFxMarketSession(friOpen).phase, "open");
assert.equal(getFxMarketSession(friOpen).reason, "장중");

assert.equal(isFxMarketClosed(friClosed), true);
assert.equal(isFxMarketOpen(friClosed), false);
assert.equal(getFxMarketSession(friClosed).phase, "friday_closed");

assert.equal(isFxMarketClosed(sat), true);
assert.equal(getFxMarketSession(sat).phase, "saturday_closed");

assert.equal(isFxMarketClosed(sunPre), true);
assert.equal(getFxMarketSession(sunPre).phase, "sunday_preopen");

assert.equal(isFxMarketOpen(sunOpen), true);
assert.equal(isFxMarketClosed(sunOpen), false);

assert.equal(isFxMarketOpen(mon), true);
assert.equal(isWeeklyMarketClosed(sat), true); // alias

// open XOR closed
for (const t of [friOpen, friClosed, sat, sunPre, sunOpen, mon]) {
  const s = getFxMarketSession(t);
  assert.equal(s.open, !s.closed);
  assert.equal(isFxMarketOpen(t), s.open);
  assert.equal(isFxMarketClosed(t), s.closed);
}

console.log("OK verify-market-hours");
