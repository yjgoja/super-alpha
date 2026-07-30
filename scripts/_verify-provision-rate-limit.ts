/**
 * Offline checks for provision auth vs transient error classification.
 * Run: npx tsx scripts/_verify-provision-rate-limit.ts
 */
import { isMt5AuthError, isNetworkTransientError, toKoreanError } from "../src/lib/ko-errors";
import {
  isProvisionAuthMessage,
  isProvisionRateLimitMessage,
  isProvisionTransientMessage,
} from "../src/lib/provision";

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
  check(`transient rate: ${JSON.stringify(s).slice(0, 40)}`, isProvisionTransientMessage(s));
}

const net = "네트워크 연결이 불안정합니다. 잠시 후 다시 시도하세요.";
check("network soft", isNetworkTransientError(net) && isProvisionTransientMessage(net));
check("network not auth", !isProvisionAuthMessage(net));

const authSamples = [
  "E_AUTH",
  "Invalid account",
  "invalid password",
  "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다.",
];
for (const s of authSamples) {
  check(`auth: ${s}`, isMt5AuthError(s) && isProvisionAuthMessage(s));
  check(`auth not transient: ${s}`, !isProvisionTransientMessage(s));
}

check(
  "toKorean E_AUTH",
  toKoreanError("E_AUTH: invalid account") ===
    "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다.",
);

const permanent = [
  "계정 배포 실패",
  "브로커 계좌 정보를 확인하지 못했습니다",
];
for (const s of permanent) {
  check(`not rate: ${s}`, !isProvisionRateLimitMessage(s));
}

if (fail > 0) {
  console.error(`\n${fail} check(s) failed`);
  process.exit(1);
}
console.log("\nAll provision rate-limit / auth checks passed.");
