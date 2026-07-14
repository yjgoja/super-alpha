/**
 * ROI TP semantics verification
 * Run: node scripts/verify-tp-roi.mjs
 */
import assert from "assert";

const LEV = 20;

function roiToPricePct(roi) {
  return roi / LEV;
}

function mt5ProfitPct(direction, avg, bid, ask) {
  const mark = direction === "BUY" ? bid : ask;
  return direction === "BUY" ? ((mark - avg) / avg) * 100 : ((avg - mark) / avg) * 100;
}

function resolveTp(takeProfitRoi, tableProfitRoi = 20) {
  const roi = takeProfitRoi > 0 ? takeProfitRoi : tableProfitRoi;
  return { tpRoi: roi, tpNeedPrice: roiToPricePct(roi) };
}

// Table L0 profit ROI 20 → price 1%
const t0 = resolveTp(0, 20);
assert(t0.tpNeedPrice === 1);

// User sets ROI 20 (after migration from price 1)
const t1 = resolveTp(20);
assert(t1.tpNeedPrice === 1);
assert(t1.tpRoi === 20);

// User sets ROI 1 (tight) → price 0.05%
const t2 = resolveTp(1);
assert(Math.abs(t2.tpNeedPrice - 0.05) < 1e-9);

// BUY: avg 1.1451, need Bid >= 1.1451 * 1.01 for ROI 20
const avg = 1.1451;
const needBid = avg * (1 + t1.tpNeedPrice / 100);
const profitOk = mt5ProfitPct("BUY", avg, needBid, needBid + 0.00012);
assert(Math.abs(profitOk - 1) < 0.001);
assert(Math.abs(profitOk * LEV - 20) < 0.02);

// Just below — should NOT TP
const profitNo = mt5ProfitPct("BUY", avg, needBid * 0.9999, needBid * 0.9999 + 0.00012);
assert(profitNo < t1.tpNeedPrice);

console.log("OK verify-tp-roi", {
  roi20_pricePct: t1.tpNeedPrice,
  eurusdBidForTp: Number(needBid.toFixed(5)),
  profitAtTarget: Number(profitOk.toFixed(4)),
  profitRoi: Number((profitOk * LEV).toFixed(2)),
});
