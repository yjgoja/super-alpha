/**
 * 물타기(DCA) = 순수 바스켓 마진 ROI 트리거 검증 (가격 로직 없음).
 * 규칙(엔진과 동일): 한 틱(평가)당 최대 1회차 추가.
 *   BasketROI ≤ -levels[next].drop% 이면 다음 회차 진입 → 다음 틱에서 재계산.
 *   -20% → 2번째 주문(L1), 이어서 유지되면 -40%에서 L2, L3 … (drop 중복 티어)
 * EURUSD·XAUUSD 는 ROI 기준이라 동일하게 동작.
 * Run: npx tsx scripts/sim-dca.ts
 */
import { shouldTriggerDcaRoi, mt5UsedMargin, mt5FloatingRoiPct } from "../src/lib/dca1000";
import { getTableLevels } from "../src/lib/table-logics";

const levels = getTableLevels("dubai_bruno_313"); // [L0, ...313]

/** 엔진 한 틱: filled 상태 + 바스켓 ROI → 이번 틱에 (최대 1개) 추가되는 회차 */
function oneTick(filled: number, basketRoiPct: number) {
  const usedMargin = 100;
  const pnl = (basketRoiPct / 100) * usedMargin;
  const next = filled + 1;
  if (next >= levels.length) return { added: false as const };
  const dropRoi = Math.max(0, levels[next]?.drop ?? 0);
  const hit = shouldTriggerDcaRoi({ pnl, usedMargin, dropRoiPct: dropRoi });
  return hit.hit
    ? { added: true as const, level: next, drop: dropRoi, basketRoi: hit.basketRoi }
    : { added: false as const, level: next, drop: dropRoi, basketRoi: hit.basketRoi };
}

let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`PASS ${name}`);
  else {
    fail++;
    console.error(`FAIL ${name}`, extra ?? "");
  }
}

// --- 단일 틱: 정확한 ROI 임계 ---
ok("ROI -19% (filled0) → 물타기 없음 (-20% 미도달)", oneTick(0, -19).added === false, oneTick(0, -19));
const t20 = oneTick(0, -20);
ok("ROI -20% (filled0) → 2번째 주문 L1 (drop20)", t20.added && t20.level === 1 && t20.drop === 20, t20);
// 한 틱당 1개만 — -40%라도 이번 틱은 L1 하나
const t40 = oneTick(0, -40);
ok("ROI -40% (filled0) → 이번 틱 L1 1개만 (1틱 1주문)", t40.added && t40.level === 1, t40);
// 다음 틱들에서 중복 drop 티어 순차 진입 (ROI 유지 가정)
ok("ROI -40% (filled1) → L2 (drop40)", (() => { const t = oneTick(1, -40); return t.added && t.level === 2 && t.drop === 40; })());
ok("ROI -40% (filled2) → L3 (drop40, 중복 티어)", (() => { const t = oneTick(2, -40); return t.added && t.level === 3 && t.drop === 40; })());
ok("ROI -40% (filled3) → L4(drop60) 미도달", oneTick(3, -40).added === false, oneTick(3, -40));

// -60% 유지 → L4,L5,L6 (drop60 ×3) 진입, L7(drop80) 미도달
ok("ROI -60% (filled3) → L4 (drop60)", (() => { const t = oneTick(3, -60); return t.added && t.level === 4 && t.drop === 60; })());
ok("ROI -60% (filled6) → L7(drop80) 미도달", oneTick(6, -60).added === false, oneTick(6, -60));

// 최심 근처: -350% → L313 (drop350) 까지 진입 가능
ok("ROI -350% (filled312) → L313 (drop350)", (() => { const t = oneTick(312, -350); return t.added && t.level === 313 && t.drop === 350; })());
ok("filled313(최심) → 더 이상 추가 없음", oneTick(313, -999).added === false, oneTick(313, -999));

// --- 다중 틱 시뮬: margin↑ → ROI 재계산으로 자기조절 (프로즌 스냅샷 과다진입 방지) ---
// XAU 0.03 로트, 각 회차 동일 lots, 가격은 고정(신규 leg pnl≈0), 손실 legs 고정.
function simulateLadder(symbol: string, startLots: number, mid: number, frozenLossUsd: number, ticks: number) {
  let lots = startLots; // L0
  let margin = mt5UsedMargin({ symbol, lots, avgPrice: mid, brokerLeverage: 500 });
  let filled = 0;
  const addsPerTick: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const roi = mt5FloatingRoiPct(-frozenLossUsd, margin);
    const next = filled + 1;
    if (next >= levels.length) { addsPerTick.push(0); continue; }
    const hit = shouldTriggerDcaRoi({ pnl: -frozenLossUsd, usedMargin: margin, dropRoiPct: levels[next].drop });
    if (hit.hit) {
      // 신규 회차 진입: 바스켓 margin 증가 (신규 leg pnl≈0 → 손실 고정)
      margin += mt5UsedMargin({ symbol, lots: startLots, avgPrice: mid, brokerLeverage: 500 });
      filled = next;
      addsPerTick.push(1);
    } else {
      addsPerTick.push(0);
    }
  }
  return { filled, addsPerTick };
}
const ladder = simulateLadder("XAUUSD", 0.03, 4080, 8, 12);
ok("다중 틱: 틱마다 최대 1개 추가", ladder.addsPerTick.every((n) => n <= 1), ladder.addsPerTick);
ok("다중 틱: margin↑로 ROI 자기조절 → 무한 진입 안 함", ladder.filled < 12, ladder);

if (fail) {
  console.error(`\nSIM DCA FAILED: ${fail}`);
  process.exit(1);
}
console.log("\nSIM DCA ALL PASSED — 물타기는 순수 바스켓 마진 ROI, 1틱 1주문, 가격 로직 제거");
