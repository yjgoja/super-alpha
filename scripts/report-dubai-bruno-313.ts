/**
 * Dubai Bruno 313 — live TP/SL $ at various fill depths (Korean report).
 * Run: npx tsx scripts/report-dubai-bruno-313.ts
 */
import {
  calcDca1000Defense,
  liveBasketTpSlUsd,
  lotsFromSize,
  resolveTpSlUsd,
  DCA1000_LEVERAGE_BASE,
} from "../src/lib/dca1000";
import { getTableLevels, getTableLeverage } from "../src/lib/table-logics";

const logic = "dubai_bruno_313";
const symbol = "EURUSD";
const startLots = 0.01;
const mid = 1.085;
const tpPct = 20;
const slPct = 225;
const levels = getTableLevels(logic);
const tableLev = getTableLeverage(logic) || DCA1000_LEVERAGE_BASE;

function basketAt(filledThrough: number) {
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
  const live = liveBasketTpSlUsd({
    symbol,
    lots: totalLots,
    avgPrice: avg,
    takeProfitPct: tpPct,
    stopLossPct: slPct,
  });
  return {
    filledThrough: through,
    levelCount: through + 1,
    totalLots: Math.round(totalLots * 100) / 100,
    avgPrice: Math.round(avg * 1e6) / 1e6,
    ...live,
  };
}

const l0 = resolveTpSlUsd({
  symbol,
  startLots,
  takeProfitPct: tpPct,
  stopLossPct: slPct,
  refMid: mid,
});
const at10 = basketAt(9); // L0..L9 = 10 levels
const at100 = basketAt(99);
const atFull = basketAt(levels.length - 1);
const defense = calcDca1000Defense({
  symbol,
  startLots,
  stopLossRoiPct: slPct,
  levels,
  refMid: mid,
  leverage: tableLev,
});

const fmt = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

console.log("=== Dubai Bruno 313 (dubai_bruno_313) · EURUSD · startLots 0.01 ===");
console.log(`표 회차 수: ${levels.length} (이름 313이지만 JSON≈${levels.length}레벨)`);
console.log(`TP% ${tpPct} · SL% ${slPct} · 표레버 ${tableLev} → 차트 손절 ${slPct / tableLev}%`);
console.log("");
console.log("--- 시작회차(L0)만 ---");
console.log(`  익절$ +${fmt(l0.takeProfitUsd)}`);
console.log(`  손절$ -${fmt(l0.stopLossUsd)}  (차트 방어, 예전 고정$≈$5 아님)`);
console.log("");
console.log("--- 10회차 채움 ---");
console.log(`  로트 ${at10.totalLots} · 익절$ +${fmt(at10.takeProfitUsd)} · 손절$ -${fmt(at10.stopLossUsd)}`);
console.log("");
console.log("--- 100회차 채움 ---");
console.log(
  `  로트 ${at100.totalLots} · 익절$ +${fmt(at100.takeProfitUsd)} · 손절$ -${fmt(at100.stopLossUsd)}`,
);
console.log("");
console.log(`--- 전체 ${atFull.levelCount}회차 채움 ---`);
console.log(
  `  로트 ${atFull.totalLots} · 익절$ +${fmt(atFull.takeProfitUsd)} · 손절$ -${fmt(atFull.stopLossUsd)}`,
);
console.log("");
console.log("--- 전체 회차 소진 시 예상 손절금 (calcDca1000Defense / MT5 cash) ---");
console.log(`  $${fmt(defense.estimatedSlAmount)} (mt5CashSlAmount $${fmt(defense.mt5CashSlAmount)})`);
console.log("");
console.log("이전 버그: 시작로트 고정 SL≈$5 → 313 가기 전에 손절. 지금은 회차 스케일.");
