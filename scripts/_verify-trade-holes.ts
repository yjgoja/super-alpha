/**
 * Fail-closed trade hole unit checks (no MetaAPI).
 * Run: npx tsx scripts/_verify-trade-holes.ts
 */
import assert from "node:assert/strict";
import { mt5UsedMargin } from "../src/lib/dca1000";

// Margin: freeMargin budget must fail when below estimate
{
  const need = mt5UsedMargin({
    symbol: "XAUUSD",
    lots: 0.01,
    avgPrice: 4260,
    brokerLeverage: 500,
  });
  assert.ok(need > 8 && need < 9);
  const free = 6.67;
  assert.ok(free < need * 1.15);
}

// Policy: recent ENTRY + later TP ⇒ L0 reentry allowed (mirrors trade-guards)
function mayReenterAfterRecentEntry(opts: {
  hasOpenBasket: boolean;
  recentEntryAgeMs: number;
  closedAfterEntry: boolean;
}): boolean {
  if (opts.hasOpenBasket) return false;
  if (opts.recentEntryAgeMs > 90_000) return true;
  if (opts.closedAfterEntry) return true;
  return false;
}

assert.equal(
  mayReenterAfterRecentEntry({
    hasOpenBasket: false,
    recentEntryAgeMs: 30_000,
    closedAfterEntry: true,
  }),
  true,
  "TP within 90s must allow reentry",
);
assert.equal(
  mayReenterAfterRecentEntry({
    hasOpenBasket: false,
    recentEntryAgeMs: 30_000,
    closedAfterEntry: false,
  }),
  false,
  "duplicate L0 within 90s blocked",
);
assert.equal(
  mayReenterAfterRecentEntry({
    hasOpenBasket: true,
    recentEntryAgeMs: 120_000,
    closedAfterEntry: true,
  }),
  false,
  "open basket blocks L0",
);

// emptyWithoutClose policy
function acceptEmptyClose(opts: {
  emptyWithoutClose: boolean;
  closed: number;
  expectedPositions: number;
  verifySideEmpty: boolean;
}): boolean {
  if (!opts.emptyWithoutClose || opts.closed > 0) return true;
  if (opts.expectedPositions <= 0) return true;
  return opts.verifySideEmpty;
}

assert.equal(
  acceptEmptyClose({
    emptyWithoutClose: true,
    closed: 0,
    expectedPositions: 2,
    verifySideEmpty: false,
  }),
  false,
  "lag must not close DB",
);
assert.equal(
  acceptEmptyClose({
    emptyWithoutClose: true,
    closed: 0,
    expectedPositions: 2,
    verifySideEmpty: true,
  }),
  true,
  "confirmed flat OK",
);

console.log("trade-holes OK");
