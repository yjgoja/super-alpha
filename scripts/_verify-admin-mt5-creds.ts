/**
 * Admin credential visibility checks (static).
 * Run: npx tsx scripts/_verify-admin-mt5-creds.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

const root = process.cwd();
function read(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

let fail = 0;
function check(name: string, pass: boolean) {
  if (pass) console.log(`PASS ${name}`);
  else {
    fail += 1;
    console.error(`FAIL ${name}`);
  }
}

const adminUsers = read("src/app/api/admin/users/route.ts");
const adminDetail = read("src/app/api/admin/users/[id]/route.ts");
const adminPage = read("src/app/admin/page.tsx");
const connect = read("src/app/api/connect/route.ts");
const me = read("src/app/api/me/route.ts");

check("admin users GET selects syncToken", /syncToken:\s*true/.test(adminUsers));
check("admin users maps mt5Password", /mt5Password:\s*syncToken/.test(adminUsers));
check("admin detail exposes mt5Password", /mt5Password:\s*syncToken/.test(adminDetail));
check("admin detail still strips passwordEnc", /passwordEnc:\s*_p/.test(adminDetail));
check("admin UI has Mt5Creds", /function Mt5Creds/.test(adminPage));
check("admin UI shows 비밀번호", /비밀번호/.test(adminPage));
check("admin UI shows 계좌번호", /계좌번호/.test(adminPage));
check("members column MT5 계좌·비밀번호", /MT5 계좌·비밀번호/.test(adminPage));

// Member-facing APIs must not return syncToken/mt5Password
check("connect response strips syncToken", /syncToken:\s*__/.test(connect) || /passwordEnc:\s*_/.test(connect));
check("me route has no mt5Password", !/mt5Password/.test(me));
check("me route does not select syncToken", !/syncToken/.test(me));

if (fail > 0) {
  console.error(`\n${fail} check(s) failed`);
  process.exit(1);
}
console.log("\nAll admin MT5 credential checks passed.");
