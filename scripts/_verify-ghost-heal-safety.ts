/**
 * Offline checks for ghost heal + backup manage-only fail-closed rules.
 * Run: npx tsx scripts/_verify-ghost-heal-safety.ts
 * Does NOT call MetaAPI or mutate live baskets.
 */
import {
  canHealGhostBasketFromDeals,
  resolveForceManageOnly,
} from "../src/lib/meta-engine";
import fs from "fs";
import path from "path";

let fail = 0;
function check(name: string, pass: boolean, detail?: string) {
  if (pass) console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    fail += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

check(
  "hist fail → cannot heal",
  canHealGhostBasketFromDeals({ histOk: false, hasOutDeal: true }) === false,
);
check(
  "no OUT deal → cannot heal",
  canHealGhostBasketFromDeals({ histOk: true, hasOutDeal: false }) === false,
);
check(
  "hist ok + OUT deal → can heal",
  canHealGhostBasketFromDeals({ histOk: true, hasOutDeal: true }) === true,
);

check("default forceManageOnly off", resolveForceManageOnly() === false);
check(
  "explicit forceManageOnly on",
  resolveForceManageOnly({ forceManageOnly: true }) === true,
);

const prev = process.env.ENGINE_BACKUP_MANAGE_ONLY;
process.env.ENGINE_BACKUP_MANAGE_ONLY = "1";
check("env ENGINE_BACKUP_MANAGE_ONLY=1", resolveForceManageOnly() === true);
if (prev == null) delete process.env.ENGINE_BACKUP_MANAGE_ONLY;
else process.env.ENGINE_BACKUP_MANAGE_ONLY = prev;

const cron = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/cron/tick/route.ts"),
  "utf8",
);
check("cron sets forceManageOnly true", /forceManageOnly:\s*true/.test(cron));

const engine = fs.readFileSync(
  path.join(process.cwd(), "src/lib/meta-engine.ts"),
  "utf8",
);
check(
  "no_price soft notes present",
  engine.includes("await_ghost_heal_no_price") && engine.includes("await_price"),
);
check(
  "heal skips when history unavailable",
  engine.includes("history unavailable (fail-closed)"),
);
check(
  "ghost soft lag guard present",
  engine.includes("await_ghost_heal_lag_guard"),
);

if (fail) {
  console.error(`${fail} failed`);
  process.exit(1);
}
console.log("all ok");
