/**
 * Safety checks for live-UI speedups — must not touch live trading paths.
 * Run: npx tsx scripts/verify-live-ui-safety.ts
 *
 * Guarantees:
 * 1) DCA engine / close / cron use fresh fetchSnapshot (not UI cache)
 * 2) UI stats route uses fetchSnapshotCached only
 * 3) Trades invalidate UI snapshot cache
 * 4) Snapshot cache respects LIVE_SNAPSHOT_CACHE_MS=0 kill switch
 * 5) Existing engine-guard still passes
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const root = path.resolve(__dirname, "..");

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function assertIncludes(hay: string, needle: string, msg: string) {
  assert.ok(hay.includes(needle), msg);
}

function assertNotIncludes(hay: string, needle: string, msg: string) {
  assert.ok(!hay.includes(needle), msg);
}

console.log("=== live UI safety (static) ===");

const metaapi = read("src/lib/metaapi.ts");
const stats = read("src/app/api/stats/route.ts");
const engine = read("src/lib/meta-engine.ts");
const closeRoute = read("src/app/api/positions/close/route.ts");
const cron = read("src/app/api/cron/tick/route.ts");
const heartbeat = read("src/components/BotHeartbeat.tsx");
const stream = read("src/app/api/live/stream/route.ts");
const home = read("src/app/(mobile)/home/page.tsx");
const market = read("src/app/(mobile)/market/page.tsx");

assertIncludes(metaapi, "export async function fetchSnapshot(", "fetchSnapshot exported");
assertIncludes(metaapi, "export async function fetchSnapshotCached(", "fetchSnapshotCached exported");
assertIncludes(metaapi, "export function invalidateSnapshotCache(", "invalidateSnapshotCache exported");
assertIncludes(
  metaapi,
  "Always fresh — used by DCA engine",
  "fetchSnapshot documented as trading-fresh",
);
assertIncludes(metaapi, "LIVE_SNAPSHOT_CACHE_MS", "UI cache kill switch env present");

// Trading paths must call fresh fetchSnapshot, never Cached
assertIncludes(engine, "fetchSnapshot(", "engine uses fetchSnapshot");
assertNotIncludes(engine, "fetchSnapshotCached", "engine must NOT use UI cache");
assertIncludes(closeRoute, "fetchSnapshot", "close route uses fetchSnapshot");
assertNotIncludes(closeRoute, "fetchSnapshotCached", "close route must NOT use UI cache");
assertIncludes(cron, "runAllBots", "cron still runs runAllBots");

// UI stats live path uses cache helper only for MetaAPI reads
assertIncludes(stats, "fetchSnapshotCached", "stats live uses fetchSnapshotCached");
assertIncludes(stats, "UI path only", "stats documents UI-only cache");
assertNotIncludes(
  stats.replace(/import[\s\S]*?from "@\/lib\/metaapi";/, ""),
  "fetchSnapshot(",
  "stats route body must not call fresh fetchSnapshot for live UI",
);

// Trades invalidate cache
assertIncludes(
  metaapi,
  "invalidateSnapshotCache(input.metaApiAccountId)",
  "placeMarketOrder invalidates cache",
);
assertIncludes(
  metaapi,
  "invalidateSnapshotCache(metaApiAccountId)",
  "closePosition/symbol close invalidates cache",
);

// Heartbeat / pages: single MetaAPI poller + bus
assertIncludes(heartbeat, "live=1&lite=1", "heartbeat uses lite live");
assertIncludes(heartbeat, "EventSource", "heartbeat opens SSE");
assertIncludes(heartbeat, "visibilityState === \"hidden\"", "SSE/meta paused when hidden");
assertIncludes(home, "subscribeLive", "home subscribes to live bus");
assertNotIncludes(home, "stats?live=1", "home no longer polls live MetaAPI directly");
assertIncludes(market, "subscribeLive", "market subscribes to live bus");
assertIncludes(stream, "Does not call MetaAPI", "SSE is DB-only");

// POST tick assist unchanged contract
assertIncludes(stats, "export async function POST", "stats POST tick assist still present");
assertIncludes(stats, "runDcaTick", "stats POST still can run user tick");

console.log("PASS: static trading/UI isolation");

console.log("\n=== engine-guard smoke ===");
const guard = spawnSync("npx", ["tsx", "scripts/verify-engine-guard.ts"], {
  cwd: root,
  encoding: "utf8",
  shell: process.platform === "win32",
});
assert.equal(guard.status, 0, `engine-guard failed:\n${guard.stdout}\n${guard.stderr}`);
console.log(guard.stdout.trim());

console.log("\n=== cache kill-switch semantics ===");
assertIncludes(
  metaapi,
  "if (ttl <= 0) return fetchSnapshotUncached(id)",
  "LIVE_SNAPSHOT_CACHE_MS=0 bypasses cache",
);
assertIncludes(
  metaapi,
  "if (value.ok) snapCache.set",
  "errors are not cached into snapCache",
);

console.log("PASS: cache kill-switch + no error cache");

console.log("\nOK verify-live-ui-safety");
