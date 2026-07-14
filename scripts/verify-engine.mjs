/**
 * Offline verification: TP 1% semantics + orphan basket logic.
 * Run: node scripts/verify-engine.mjs
 */
import assert from "assert";

function mt5ProfitPct(direction, avgEntry, bid, ask) {
  if (!(avgEntry > 0)) return 0;
  const mark = direction === "BUY" ? bid : ask;
  return direction === "BUY"
    ? ((mark - avgEntry) / avgEntry) * 100
    : ((avgEntry - mark) / avgEntry) * 100;
}

function symbolsMatch(a, b) {
  const norm = (s) => {
    const u = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (u === "GOLD" || u.startsWith("XAU")) return "XAUUSD";
    return u;
  };
  return a === b || a.toUpperCase() === b.toUpperCase() || norm(a) === norm(b);
}

// --- TP 1% (차트 가격) ---
// BUY: Ask 진입 1.08514, Bid가 avg*1.01 이상이어야 익절
const avgAsk = 1.08514;
const tpNeed = 1.0; // 사용자 설정 익절 1%
const buySlBidNeeded = avgAsk * (1 + tpNeed / 100);
const profitAtTarget = mt5ProfitPct("BUY", avgAsk, buySlBidNeeded, buySlBidNeeded + 0.00028);
assert(Math.abs(profitAtTarget - 1) < 0.001, `TP profit should be ~1, got ${profitAtTarget}`);

// EURUSD: 1% ≈ 108.5 pips (price * 0.01 / 0.0001)
const eurusdPips = (avgAsk * 0.01) / 0.0001;
assert(eurusdPips > 100 && eurusdPips < 120, `pips ${eurusdPips}`);

// XAU: 1% of 2350 = $23.5
const xauTpMove = 2350 * 0.01;
assert(Math.abs(xauTpMove - 23.5) < 0.01, `xau move ${xauTpMove}`);

// Spread means mid must move a bit more than 1% for BUY to hit Bid TP
const mid0 = 1.085;
const half = 0.00014;
const ask0 = mid0 + half;
const bidForTp = ask0 * 1.01;
const midForTp = bidForTp + half;
const midMovePct = ((midForTp - mid0) / mid0) * 100;
assert(midMovePct > 1.0, `mid move with spread should be >1%, got ${midMovePct}`);

// --- symbol alias ---
assert(symbolsMatch("XAUUSD", "GOLD"));
assert(symbolsMatch("GOLD", "XAUUSD"));
assert(symbolsMatch("EURUSD", "EURUSD"));
assert(!symbolsMatch("EURUSD", "XAUUSD"));

// --- orphan rule ---
function shouldReenter(basket, positions) {
  if (basket && basket.legs.length > 0 && positions.length === 0) return true;
  if (!basket || basket.legs.length === 0) {
    if (positions.length > 0) return false; // external
    return true; // fresh entry
  }
  return false;
}
assert(shouldReenter({ legs: [{ level: 0 }] }, []) === true, "orphan must reenter");
assert(shouldReenter(null, []) === true, "no basket entry");
assert(shouldReenter(null, [{ symbol: "EURUSD" }]) === false, "external skip");

console.log("OK verify-engine");
console.log(
  JSON.stringify(
    {
      takeProfitMeaning: "차트 가격 % (ROI 아님)",
      example: {
        eurusdEntryAsk: avgAsk,
        tpNeedPct: tpNeed,
        bidToTp: Number(buySlBidNeeded.toFixed(5)),
        approxPips: Number(eurusdPips.toFixed(1)),
        xauUsdMoveAt2350: xauTpMove,
        midMovePctWithSpread: Number(midMovePct.toFixed(4)),
      },
    },
    null,
    2,
  ),
);
