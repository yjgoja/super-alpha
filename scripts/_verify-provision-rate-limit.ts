/**
 * Offline checks for admin provision rate-limit soft-fail behavior.
 * Run: npx tsx scripts/_verify-provision-rate-limit.ts
 *
 * Does NOT call MetaAPI or touch live baskets.
 */
import { isRateLimitError } from "../src/lib/ko-errors";
import { isProvisionRateLimitMessage } from "../src/lib/provision";

let fail = 0;
function check(name: string, pass: boolean, detail?: string) {
  if (pass) console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    fail += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const rateSamples = [
  "요청 제한 · 잠시 후 재시도 중…",
  "요청 제한 · 자동 재시도 대기 중… (실패로 표시하지 않음)",
  "Too many requests",
  "HTTP 429",
  "RATE_LIMIT",
  "rate_limit exceeded",
  { message: "Rate limit exceeded" },
];

for (const s of rateSamples) {
  check(`rate detect: ${JSON.stringify(s).slice(0, 48)}`, isProvisionRateLimitMessage(s));
}

check("ko isRateLimitError 요청 제한", isRateLimitError("요청 제한 · 재시도"));
check("ko isRateLimitError rate_limit", isRateLimitError("RATE_LIMIT"));

const permanent = [
  "계정 배포 실패",
  "비밀번호가 올바르지 않습니다",
  "브로커 계좌 정보를 확인하지 못했습니다",
];
for (const s of permanent) {
  check(`not rate: ${s}`, !isProvisionRateLimitMessage(s));
}

if (fail > 0) {
  console.error(`\n${fail} check(s) failed`);
  process.exit(1);
}
console.log("\nAll provision rate-limit checks passed.");
