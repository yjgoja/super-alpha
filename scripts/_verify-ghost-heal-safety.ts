/**
 * Offline checks for ghost heal + backup manage-only fail-closed rules.
 * Run: npx tsx scripts/_verify-ghost-heal-safety.ts
 * Does NOT call MetaAPI or mutate live baskets.
 */
import {
  canHealGhostBasketFromDeals,
  canReconcileEmptyGhostSide,
  ghostBasketAgeMs,
  resolveForceManageOnly,
  shouldSkipGhostHealForAccountLag,
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

// Multi-symbol float must NOT block ghost heal when other positions exist
check(
  "lag skip only when whole book empty + float",
  shouldSkipGhostHealForAccountLag({
    positionsCount: 0,
    margin: 0,
    equity: 100,
    balance: 200,
  }) === true,
);
check(
  "other positions → never lag-skip",
  shouldSkipGhostHealForAccountLag({
    positionsCount: 3,
    margin: 500,
    equity: 1000,
    balance: 1100,
  }) === false,
);
check(
  "empty flat book → no lag skip",
  shouldSkipGhostHealForAccountLag({
    positionsCount: 0,
    margin: 0,
    equity: 1000,
    balance: 1000,
  }) === false,
);

check(
  "reconcile when other positions exist",
  canReconcileEmptyGhostSide({
    sideEmpty: true,
    otherPositionsExist: true,
    margin: 50,
    equity: 900,
    balance: 1000,
  }) === true,
);
check(
  "no reconcile when whole-book lag",
  canReconcileEmptyGhostSide({
    sideEmpty: true,
    otherPositionsExist: false,
    margin: 50,
    equity: 900,
    balance: 1000,
  }) === false,
);
check(
  "reconcile when account truly flat",
  canReconcileEmptyGhostSide({
    sideEmpty: true,
    otherPositionsExist: false,
    margin: 0,
    equity: 1000,
    balance: 1000,
  }) === true,
);

const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
check("ghost age from createdAt", ghostBasketAgeMs({ createdAt: old }) > 2 * 60 * 60 * 1000);

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
check(
  "whole-book lag wording",
  engine.includes("whole-book lag") || engine.includes("whole-book margin/float"),
);
check(
  "stale empty reconcile note",
  engine.includes("ghost_reconcile_stale_empty"),
);

if (fail) {
  console.error(`${fail} failed`);
  process.exit(1);
}
console.log("all ok");
