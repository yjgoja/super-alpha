/**
 * Offline checks for Zero Markets H8 session clock helpers.
 * Run: npx tsx scripts/_verify-session-h8.ts
 */
import assert from "node:assert/strict";
import {
  H8_ENTRY_DELAY_MIN,
  H8_OPEN_MINS,
  brokerParts,
  canH8Enter,
  currentH8OpenMin,
  h8DirectionFromOpen,
  h8SessionKey,
  isH8EntryMinute,
  isH8OpenMinute,
  isInH8EntryQuiet,
  minutesSinceH8Open,
} from "../src/lib/session-h8";
import { isMartin9TimeLogic, martinTimeBaseLogic, getMartin9Defense } from "../src/lib/table-logics";

assert.deepEqual([...H8_OPEN_MINS], [0, 480, 960]);
assert.equal(H8_ENTRY_DELAY_MIN, 15);

assert.equal(currentH8OpenMin(0), 0);
assert.equal(currentH8OpenMin(14), 0);
assert.equal(currentH8OpenMin(480), 480);
assert.equal(currentH8OpenMin(500), 480);
assert.equal(currentH8OpenMin(960), 960);
assert.equal(currentH8OpenMin(1439), 960);

// Summer EEST (Athens UTC+3): 2026-07-15 00:00 Athens = 2026-07-14 21:00 UTC
const open0 = new Date("2026-07-14T21:00:00.000Z");
assert.equal(brokerParts(open0).minutesOfDay, 0);
assert.ok(isH8OpenMinute(open0));
assert.equal(h8SessionKey(open0), "2026-07-15-0");
assert.equal(minutesSinceH8Open(open0), 0);
assert.ok(isInH8EntryQuiet(open0));
assert.ok(!canH8Enter(open0));

const entry0 = new Date("2026-07-14T21:15:00.000Z");
assert.equal(brokerParts(entry0).minutesOfDay, 15);
assert.ok(isH8EntryMinute(entry0));
assert.ok(canH8Enter(entry0));
assert.ok(!isInH8EntryQuiet(entry0));

// 08:00 Athens
const open8 = new Date("2026-07-15T05:00:00.000Z");
assert.equal(brokerParts(open8).minutesOfDay, 480);
assert.ok(isH8OpenMinute(open8));
assert.equal(h8SessionKey(open8), "2026-07-15-480");

// 16:00 Athens
const open16 = new Date("2026-07-15T13:00:00.000Z");
assert.equal(brokerParts(open16).minutesOfDay, 960);
assert.ok(isH8OpenMinute(open16));
assert.equal(h8SessionKey(open16), "2026-07-15-960");

assert.equal(h8DirectionFromOpen(100.1, 100), "BUY");
assert.equal(h8DirectionFromOpen(99.9, 100), "SELL");
assert.equal(h8DirectionFromOpen(100, 100), null);

assert.ok(isMartin9TimeLogic("martin_9_068_time"));
assert.ok(isMartin9TimeLogic("martin_9_35_time"));
assert.ok(!isMartin9TimeLogic("martin_9_068"));
assert.equal(martinTimeBaseLogic("martin_9_068_time"), "martin_9_068");
assert.equal(martinTimeBaseLogic("martin_9_35_time"), "martin_9_35");

const d068 = getMartin9Defense("martin_9_068");
const d068t = getMartin9Defense("martin_9_068_time");
const d35 = getMartin9Defense("martin_9_35");
const d35t = getMartin9Defense("martin_9_35_time");
assert.ok(d068 && d068t && d35 && d35t);
assert.equal(d068.dropScale, d068t.dropScale);
assert.equal(d068.stopLossPct, d068t.stopLossPct);
assert.equal(d35.dropScale, d35t.dropScale);
assert.equal(d35.stopLossPct, d35t.stopLossPct);

console.log("session-h8 verify OK");
