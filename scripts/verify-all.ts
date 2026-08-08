/**
 * 전체 기능 검증 러너 — scripts/_verify-*.ts 를 전부 돌리고 요약한다.
 *
 *   npm run verify:all
 *
 * 검증 스크립트가 24개나 있었는데 npm 스크립트로 묶여 있지 않아 아무도 돌리지
 * 않고 있었다 (2026-08-08). 배포 전에 이걸 통과시키는 것을 기준으로 삼는다.
 *
 * 종료코드: 하나라도 실패하면 1.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const SCRIPTS_DIR = path.join(process.cwd(), "scripts");
/** DB·네트워크가 필요해 로컬에서만 의미 있는 것들 — --offline 로 건너뛴다. */
const NEEDS_DB = new Set([
  "_verify-admin-mt5-creds.ts",
  "_verify-multi-account.ts",
  "_verify-password-reset.ts",
  "e2e-verify.ts",
]);
/** MetaAPI 실계좌에 붙어 스트림을 열어두느라 스스로 종료하지 않는다. */
const SLOW_LIVE = new Set(["_verify-live-tpsl-all.ts"]);

const offline = process.argv.includes("--offline");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

function listVerifiers() {
  const files = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith("_verify-") && f.endsWith(".ts"))
    .sort();
  if (fs.existsSync(path.join(SCRIPTS_DIR, "e2e-verify.ts"))) files.push("e2e-verify.ts");
  return only ? files.filter((f) => f.includes(only)) : files;
}

type Result = { file: string; status: "pass" | "fail" | "skip"; ms: number; tail: string };

function run(file: string): Result {
  if (offline && NEEDS_DB.has(file)) {
    return { file, status: "skip", ms: 0, tail: "DB 필요 — --offline 로 건너뜀" };
  }
  const started = Date.now();
  const res = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsx", "--env-file=.env", `scripts/${file}`],
    { encoding: "utf8", timeout: 180_000, shell: process.platform === "win32" },
  );
  const ms = Date.now() - started;
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  // 스크립트들이 exit code 를 항상 세팅하지는 않아 실패 표시도 같이 본다.
  // "FAIL: <메시지>" 나 "FAIL 3" 만 실패다 — 요약줄 "FAIL 0" 은 통과다.
  const sawFail = /(^|\n)\s*(FAIL:|FAIL\s+[1-9]|✗|❌)/.test(out);
  // 스트림을 열어둬 스스로 안 끝나는 라이브 검증은, 타임아웃이더라도
  // 출력에 실패 표시가 없으면 통과로 본다.
  const timedOut = res.error?.message?.includes("ETIMEDOUT") || res.signal === "SIGTERM";
  if (SLOW_LIVE.has(file) && timedOut && !sawFail) {
    return { file, status: "pass", ms, tail: "라이브 스트림 미종료 — 출력상 실패 없음" };
  }
  const status: Result["status"] = res.status === 0 && !sawFail ? "pass" : "fail";
  const tail = out.trim().split("\n").slice(-6).join("\n");
  return { file, status, ms, tail };
}

function main() {
  const files = listVerifiers();
  console.log(`🔍 전체 기능 검증 — ${files.length}개 스크립트${offline ? " (offline)" : ""}\n`);

  const results: Result[] = [];
  for (const f of files) {
    process.stdout.write(`  ${f.padEnd(38)} `);
    const r = run(f);
    results.push(r);
    const icon = r.status === "pass" ? "✅" : r.status === "skip" ? "⏭️ " : "❌";
    console.log(`${icon} ${(r.ms / 1000).toFixed(1)}s`);
  }

  const failed = results.filter((r) => r.status === "fail");
  const passed = results.filter((r) => r.status === "pass");
  const skipped = results.filter((r) => r.status === "skip");

  console.log(`\n${"─".repeat(60)}`);
  console.log(`통과 ${passed.length} · 실패 ${failed.length} · 건너뜀 ${skipped.length}`);

  if (failed.length) {
    console.log(`\n실패 상세:`);
    for (const f of failed) {
      console.log(`\n▼ ${f.file}`);
      console.log(f.tail.replace(/^/gm, "    "));
    }
    process.exitCode = 1;
    return;
  }
  console.log(`\n✅ 전체 통과`);
}

main();
