/**
 * Dubai Bruno 313 — authoritative table report (Korean).
 * 표 profit(익절 ROI)은 회차별(20/25/30%). 엔진과 동일하게 "현재 가장 깊은 회차"의
 * profit% 를 바스켓 익절 ROI 로 사용. 손절은 225% 고정.
 * Run: npx tsx scripts/report-dubai-bruno-313.ts
 */
import {
  liveBasketTpSlUsd,
  lotsFromSize,
  DCA1000_LEVERAGE_BASE,
  MT5_REF_MID,
} from "../src/lib/dca1000";
import { getTableLevels, getTableLeverage, tableLogicMeta } from "../src/lib/table-logics";

const logic = "dubai_bruno_313";
const slPct = 225;
const levels = getTableLevels(logic); // [L0, ...935 rows]
const tableLev = getTableLeverage(logic) || DCA1000_LEVERAGE_BASE;
const meta = tableLogicMeta(logic);

/** filledThrough = 0-based deepest level index (회차 = filledThrough+1) */
function basketAt(symbol: string, mid: number, startLots: number, filledThrough: number) {
  const through = Math.min(filledThrough, levels.length - 1);
  let totalLots = 0;
  let sumPx = 0;
  for (let i = 0; i <= through; i++) {
    const lv = levels[i];
    const lots = lotsFromSize(lv.size, startLots);
    const adverse = i === 0 ? 0 : lv.drop / tableLev / 100;
    const px = mid * (1 - adverse);
    totalLots += lots;
    sumPx += lots * px;
  }
  const avg = totalLots > 0 ? sumPx / totalLots : mid;
  const levelProfit = levels[through]?.profit ?? 20; // 엔진과 동일: 현재 회차 profit%
  const live = liveBasketTpSlUsd({
    symbol,
    lots: totalLots,
    avgPrice: avg,
    takeProfitPct: levelProfit,
    stopLossPct: slPct,
  });
  return {
    levelNo: through + 1,
    tpRoi: levelProfit,
    totalLots: Math.round(totalLots * 100) / 100,
    ...live,
  };
}

const fmt = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

console.log("=== Dubai Bruno 313 (dubai_bruno_313) · 정본표 ===");
console.log(`파일 데이터 행 수: ${meta.dcaRows} (물타기 레벨) · L0 포함 총 ${meta.count}레벨/회차`);
console.log(`익절 ROI: 회차별 profit% (drop≤130→20, drop140→25, drop150→30) · 손절 ${slPct}% · 표레버 ${tableLev} · 브로커레버 500`);
console.log("");

// 회차 마커: L0=1, 10, 50, 100, 200, 419(첫 25%), 700(첫 30%), 최종
const markers = [1, 10, 50, 100, 200, 419, 700, levels.length];

const starts: Record<string, number> = { EURUSD: 0.08, XAUUSD: 0.03 };
for (const symbol of ["EURUSD", "XAUUSD"]) {
  const mid = MT5_REF_MID[symbol];
  const startLots = starts[symbol];
  console.log(`--- ${symbol} (mid ${mid}, startLots ${startLots}) ---`);
  console.log(`회차\tTP%\t로트\t증거금$\t익절$\t손절$(225%)`);
  for (const m of markers) {
    const b = basketAt(symbol, mid, startLots, m - 1);
    const tag = m === 1 ? "L0" : String(b.levelNo);
    console.log(
      `${tag}\t${b.tpRoi}\t${fmt(b.totalLots)}\t${fmt(b.marginUsd)}\t+${fmt(b.takeProfitUsd)}\t-${fmt(b.stopLossUsd)}`,
    );
  }
  console.log("");
}
