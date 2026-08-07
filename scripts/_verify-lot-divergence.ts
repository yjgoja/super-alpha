/**
 * lot-divergence guard smoke test — no DB required
 *   npx tsx scripts/_verify-lot-divergence.ts
 */
import assert from "assert";
import { shouldBlockDcaForLotDivergence } from "../src/lib/meta-engine";

const block = (ladderLots: number, brokerLots: number) =>
  shouldBlockDcaForLotDivergence({ ladderLots, brokerLots });

// 실제 사고 재현: DB 사다리 10.16 lots vs 브로커 31.28 lots (2026-08-08, GBPUSD)
assert.equal(block(10.16, 31.28), true, "실제 3배 괴리는 차단되어야 함");

// 정상: 브로커와 사다리가 일치
assert.equal(block(10.16, 10.16), false, "일치하면 통과");

// 부분 체결/반올림 오차는 통과 (10% 허용)
assert.equal(block(10.0, 10.9), false, "9% 초과분은 허용 오차 내");
assert.equal(block(10.0, 11.01), true, "10% 넘으면 차단");

// 소액 바스켓: 최소 허용치 0.02 lots
assert.equal(block(0.08, 0.09), false, "0.01 차이는 최소 허용치 내");
assert.equal(block(0.08, 0.11), true, "0.03 차이는 차단 (0.08+0.02)");

// 브로커가 더 적은 경우는 이 가드 소관이 아님 (기존 soft reconcile 담당)
assert.equal(block(10.16, 5.0), false, "브로커가 적으면 차단 안 함");

// 사다리가 0이면 판단 불가 — 차단하지 않음
assert.equal(block(0, 5), false, "ladder 0 이면 판단 보류");
assert.equal(block(-1, 5), false, "음수 방어");

// 실제 사고 2번 계좌: 2.55 vs 3.15
assert.equal(block(2.55, 3.15), true, "jnl5branrm 케이스 차단");

console.log("All lot-divergence guard checks passed.");
