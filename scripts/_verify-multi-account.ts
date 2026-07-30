/**
 * Offline checks for multi-account selection helpers.
 * Run: npx tsx scripts/_verify-multi-account.ts
 */
import { readFileSync } from "fs";
import { accountLabel, MAX_BROKER_ACCOUNTS_PER_USER } from "../src/lib/account-selection";

let fail = 0;
function check(name: string, pass: boolean, detail?: string) {
  if (pass) console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    fail += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

check("max accounts >= 2", MAX_BROKER_ACCOUNTS_PER_USER >= 2);
check("label uses displayName", accountLabel({ displayName: "메인", login: "123" }) === "메인");
check("label falls back to login", accountLabel({ displayName: "", login: "123" }) === "MT5 123");

const connect = readFileSync("src/app/api/connect/route.ts", "utf8");
check("connect supports add", /add:\s*z\.boolean/.test(connect) || connect.includes("add:"));
check("connect does not only overwrite newest", connect.includes("MAX_BROKER_ACCOUNTS_PER_USER"));

const accountsApi = readFileSync("src/app/api/accounts/route.ts", "utf8");
check("accounts API has select", accountsApi.includes('action: z.literal("select")'));
check("accounts API has rename", accountsApi.includes('action: z.literal("rename")'));
check("accounts API has DELETE", accountsApi.includes("export async function DELETE"));

const manage = readFileSync("src/app/(mobile)/manage/page.tsx", "utf8");
check("manage page lists accounts", manage.includes("/api/accounts"));
check("manage page can add", manage.includes("/connect?add=1"));
check("manage page can delete", manage.includes("계좌 삭제"));
check("manage page can rename", manage.includes("계좌 이름"));

const me = readFileSync("src/app/api/me/route.ts", "utf8");
check("me returns accounts list", me.includes("accounts:"));
check("me returns activeAccountId", me.includes("activeAccountId"));

if (fail > 0) {
  console.error(`\n${fail} failed`);
  process.exit(1);
}
console.log("\nAll multi-account checks passed.");
