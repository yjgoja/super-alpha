/**
 * 두바이부르노 정본표 검증 (313 데이터 행 → L0 포함 314 레벨/주문):
 * 1) 파일 행 수 = 313 (물타기), 총 레벨 314 (L0 + 313)
 * 2) profit 티어: 20→25→30→45→60→70→100→110→125 (깊이 증가)
 * 3) 엔진 규칙(현재 가장 깊은 회차 profit% = 바스켓 익절 ROI) 재현 검증
 * 4) 물타기 drop: L1=-20 … 최심=-350
 * Run: npx tsx scripts/sim-dubai-tp.ts
 */
import { liveBasketTpSlUsd, lotsFromSize } from "../src/lib/dca1000";
import { getTableLevels, tableLogicMeta } from "../src/lib/table-logics";

const logic = "dubai_bruno_313";
const levels = getTableLevels(logic); // [L0, ...313 rows]
const meta = tableLogicMeta(logic);

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}`, extra ?? "");
  }
}

// 엔진 규칙(meta-engine tpRoiFallback, isBulkLogic 경로)과 동일:
// 현재 가장 깊은 회차 index 의 표 profit% 를 바스켓 익절 ROI 로 사용.
function engineTpRoi(filledLevel: number) {
  const p = levels[Math.max(0, Math.min(filledLevel, levels.length - 1))]?.profit;
  return p != null && p > 0 ? p : 20;
}
function dropAt(filledLevel: number) {
  return levels[Math.max(0, Math.min(filledLevel, levels.length - 1))]?.drop;
}

// --- 구조 ---
ok("파일 데이터 행 수 313", meta.dcaRows === 313, meta.dcaRows);
ok("총 레벨 314 (L0+313)", meta.count === 314, meta.count);

// --- L0 / 물타기 drop 경계 ---
ok("L0 drop 0 (조건 없음)", dropAt(0) === 0, dropAt(0));
ok("L1 drop -20 (2번째 주문 = 바스켓 ROI ≤ -20%)", dropAt(1) === 20, dropAt(1));
ok("최심 회차(idx313) drop 350", dropAt(313) === 350, dropAt(313));

// --- profit 티어 경계 (index = CSV 행 번호) ---
ok("L0 profit 20", engineTpRoi(0) === 20);
ok("idx16 profit 20 (20%대 마지막)", engineTpRoi(16) === 20, engineTpRoi(16));
ok("idx17 profit 25 (첫 25%)", engineTpRoi(17) === 25 && dropAt(17) === 130, {
  profit: engineTpRoi(17),
  drop: dropAt(17),
});
ok("idx61 profit 30 (첫 30%, drop230)", engineTpRoi(61) === 30 && dropAt(61) === 230, {
  profit: engineTpRoi(61),
  drop: dropAt(61),
});
ok("idx92 profit 45 (drop270)", engineTpRoi(92) === 45 && dropAt(92) === 270, {
  profit: engineTpRoi(92),
  drop: dropAt(92),
});
ok("idx139 profit 60 (drop310)", engineTpRoi(139) === 60 && dropAt(139) === 310, {
  profit: engineTpRoi(139),
  drop: dropAt(139),
});
ok("idx181 profit 70 (drop310)", engineTpRoi(181) === 70 && dropAt(181) === 310, {
  profit: engineTpRoi(181),
  drop: dropAt(181),
});
ok("idx209 profit 100 (drop350)", engineTpRoi(209) === 100 && dropAt(209) === 350, {
  profit: engineTpRoi(209),
  drop: dropAt(209),
});
ok("idx251 profit 110 (drop350)", engineTpRoi(251) === 110 && dropAt(251) === 350, {
  profit: engineTpRoi(251),
  drop: dropAt(251),
});
ok("idx301 profit 125 (drop350)", engineTpRoi(301) === 125 && dropAt(301) === 350, {
  profit: engineTpRoi(301),
  drop: dropAt(301),
});
ok("최심 회차(idx313) profit 125", engineTpRoi(313) === 125, engineTpRoi(313));

// profit 은 깊이에 따라 단조 증가 (20→25→30→45→60→70→100→110→125)
let monotonic = true;
for (let i = 1; i < levels.length; i++) {
  if (engineTpRoi(i) < engineTpRoi(i - 1)) {
    monotonic = false;
    break;
  }
}
ok("profit 단조 비감소 (깊이↑ → TP%↑)", monotonic);

// 티어별 개수 검증
const tierCounts: Record<string, number> = {};
for (let i = 1; i < levels.length; i++) {
  const key = `p${levels[i].profit}/d${levels[i].drop}`;
  tierCounts[key] = (tierCounts[key] || 0) + 1;
}
const expectCounts: Record<string, number> = {
  "p20/d20": 1,
  "p20/d40": 2,
  "p20/d60": 3,
  "p20/d80": 4,
  "p20/d100": 6,
  "p25/d130": 9,
  "p25/d160": 14,
  "p25/d190": 21,
  "p30/d230": 31,
  "p45/d270": 47,
  "p60/d310": 42,
  "p70/d310": 28,
  "p100/d350": 42,
  "p110/d350": 50,
  "p125/d350": 13,
};
for (const [k, v] of Object.entries(expectCounts)) {
  ok(`티어 ${k} 개수 ${v}`, tierCounts[k] === v, tierCounts[k]);
}

// --- TP$ 가 현재 회차 profit% 로 스케일되는지 (EURUSD 0.08) ---
const mid = 1.085;
const startLots = 0.08;
function tpAt(filled: number) {
  let lots = 0;
  for (let i = 0; i <= filled; i++) lots += lotsFromSize(levels[i].size, startLots);
  const live = liveBasketTpSlUsd({
    symbol: "EURUSD",
    lots,
    avgPrice: mid,
    takeProfitPct: engineTpRoi(filled),
    stopLossPct: 225,
  });
  return { lots, ...live };
}
ok("idx61 TP ROI = 30%", tpAt(61).takeProfitPct === 30, tpAt(61).takeProfitPct);
ok("idx17 TP ROI = 25%", tpAt(17).takeProfitPct === 25);
ok("idx0 TP ROI = 20%", tpAt(0).takeProfitPct === 20);
ok("idx313 TP ROI = 125%", tpAt(313).takeProfitPct === 125, tpAt(313).takeProfitPct);

console.log("");
if (fail === 0) console.log(`SIM DUBAI-TP ALL PASSED (${pass})`);
else {
  console.log(`SIM DUBAI-TP FAILED: ${fail} (passed ${pass})`);
  process.exit(1);
}
