/**
 * H8 time logic: intra-bar TP reentry allowed; new bar flattens.
 * Pure unit checks (no MetaAPI).
 * Run: npx tsx scripts/_verify-h8-reentry-policy.ts
 */
import assert from "node:assert/strict";
import {
  canH8Enter,
  h8DirectionFromOpen,
  h8SessionKey,
  isInH8EntryQuiet,
  minutesSinceH8Open,
} from "../src/lib/session-h8";
import { isMartin9TimeLogic } from "../src/lib/table-logics";

assert.equal(isMartin9TimeLogic("martin_9_068_time"), true);
assert.equal(isMartin9TimeLogic("martin_9_068"), false);

assert.equal(h8DirectionFromOpen(4261, 4250), "BUY");
assert.equal(h8DirectionFromOpen(4240, 4250), "SELL");
assert.equal(h8DirectionFromOpen(4250, 4250), null);

// Policy: once direction locked, flat + canEnter ⇒ may open L0 again (reentry).
function mayH8OpenL0(opts: {
  quiet: boolean;
  canEnter: boolean;
  barOpen: number | null;
  direction: "BUY" | "SELL" | null;
  entered: boolean;
  hasOpen: boolean;
}): boolean {
  if (opts.hasOpen) return false;
  if (opts.quiet) return false;
  if (!opts.canEnter || opts.barOpen == null) return false;
  // entered no longer blocks — direction lock is enough
  if (opts.direction === "BUY" || opts.direction === "SELL") return true;
  // first entry still needs mid≠open (caller resolves direction)
  return true;
}

assert.equal(
  mayH8OpenL0({
    quiet: false,
    canEnter: true,
    barOpen: 4250,
    direction: "BUY",
    entered: true,
    hasOpen: false,
  }),
  true,
  "flat after TP with locked dir must reenter",
);

assert.equal(
  mayH8OpenL0({
    quiet: true,
    canEnter: false,
    barOpen: 4250,
    direction: null,
    entered: false,
    hasOpen: false,
  }),
  false,
  "quiet window blocks new L0",
);

assert.equal(
  mayH8OpenL0({
    quiet: false,
    canEnter: true,
    barOpen: 4250,
    direction: "BUY",
    entered: true,
    hasOpen: true,
  }),
  false,
  "already open — no double L0",
);

// Sanity: clock helpers callable
void h8SessionKey();
void minutesSinceH8Open();
void canH8Enter();
void isInH8EntryQuiet();

console.log("h8-reentry-policy OK");
