/**
 * 두바이부르노 정본표 검증:
 * 1) 파일 행 수 = 935 (L0 포함 936레벨)
 * 2) profit 티어: drop≤130→20, drop140→25, drop150→30
 * 3) 엔진 규칙(현재 회차 profit% = 바스켓 익절 ROI) 재현 검증
 * Run: npx tsx scripts/sim-dubai-tp.ts
 */
import { liveBasketTpSlUsd, lotsFromSize } from "../src/lib/dca1000";
import { getTableLevels, tableLogicMeta } from "../src/lib/table-logics";

const logic = "dubai_bruno_313";
const levels = getTableLevels(logic); // [L0, ...935]
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

ok("파일 행 수 935", meta.dcaRows === 935, meta.dcaRows);
ok("총 레벨 936 (L0+935)", meta.count === 936, meta.count);
ok("L0 profit 20", engineTpRoi(0) === 20);
ok("회차10(idx9) profit 20", engineTpRoi(9) === 20);
ok("회차200(idx199) profit 20", engineTpRoi(199) === 20);
ok("첫 25% = 회차419(idx418), drop140", engineTpRoi(418) === 25 && levels[418].drop === 140, {
  profit: levels[418].profit,
  drop: levels[418].drop,
});
ok("직전 회차418(idx417) 은 아직 20%", engineTpRoi(417) === 20);
ok("첫 30% = 회차700(idx699), drop150", engineTpRoi(699) === 30 && levels[699].drop === 150, {
  profit: levels[699].profit,
  drop: levels[699].drop,
});
ok("직전 회차699(idx698) 은 아직 25%", engineTpRoi(698) === 25);
ok("최종 회차936(idx935) profit 30", engineTpRoi(935) === 30);

// TP$ 가 현재 회차 profit% 로 스케일되는지 (EURUSD 0.08)
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
const a = tpAt(699); // 30% tier
ok("회차700 TP ROI = 30%", tpAt(699).takeProfitPct === 30, a.takeProfitPct);
ok("회차419 TP ROI = 25%", tpAt(418).takeProfitPct === 25);
ok("회차200 TP ROI = 20%", tpAt(199).takeProfitPct === 20);

console.log("");
if (fail === 0) console.log(`SIM DUBAI-TP ALL PASSED (${pass})`);
else {
  console.log(`SIM DUBAI-TP FAILED: ${fail} (passed ${pass})`);
  process.exit(1);
}
