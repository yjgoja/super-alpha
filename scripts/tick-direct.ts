/**
 * Direct realtime engine — MetaAPI + DB on this machine (lowest latency).
 *
 * Hard requirements for live money:
 * - Always-on Postgres (Neon serverless blocked)
 * - Startup DB ping + env guard
 * - Fatal DB errors → process.exit (supervisor restarts with fresh .env)
 * - Single-instance PID lock
 *
 *   npm run engine
 *   scripts/start-engine.ps1  (recommended: auto-restart supervisor)
 */
import fs from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import {
  assertTradingDatabase,
  isFatalEngineError,
} from "../src/lib/engine-guard";
import { runAllBots, runDcaTick } from "../src/lib/meta-engine";
import { logMetaApiHttpWindow } from "../src/lib/metaapi-metrics";
import {
  countNakedBrokerPositions,
  countRecentGuards,
  logEngineObservability,
} from "../src/lib/engine-obs";
import {
  isMetaStreamEnabled,
  pruneStreams,
  streamPoolSize,
  warmStreams,
} from "../src/lib/metaapi-stream";

process.env.ENGINE_MODE = "direct";
// Prefer streaming terminalState for snaps (0 REST credits) unless explicitly off.
if (process.env.METAAPI_STREAM == null || process.env.METAAPI_STREAM === "") {
  process.env.METAAPI_STREAM = "1";
}

/** Reconcile interval. With open-basket stream on, default 60s; else 2s. */
const STREAM_ON =
  (process.env.STREAM_OPEN_BASKETS || "1").trim() !== "0" &&
  (process.env.STREAM_OPEN_BASKETS || "1").toLowerCase() !== "false";
const INTERVAL_MS = Math.max(
  STREAM_ON ? 5000 : 1500,
  Number(
    process.env.ENGINE_INTERVAL_MS ||
      (STREAM_ON ? 60_000 : 2000),
  ),
);
const STREAM_INTERVAL_MS = Math.max(
  2000,
  Number(process.env.STREAM_OPEN_INTERVAL_MS || 12_000),
);
const STREAM_MAX = Math.min(
  100,
  Math.max(1, Number(process.env.STREAM_OPEN_MAX || 20)),
);
const STREAM_CONCURRENCY = Math.min(
  8,
  Math.max(1, Number(process.env.STREAM_OPEN_CONCURRENCY || 2)),
);
const OUT_DIR = path.join(process.cwd(), "scripts", "out");
const PID_FILE = path.join(OUT_DIR, "engine.pid");
const HEARTBEAT_FILE = path.join(OUT_DIR, "engine-heartbeat.json");
const MAX_CONSECUTIVE_FAILS = Math.max(
  3,
  Number(process.env.ENGINE_MAX_CONSECUTIVE_FAILS || 8),
);

let running = false;
let ticks = 0;
let consecutiveFails = 0;
let shuttingDown = false;

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquirePidLock() {
  ensureOutDir();
  if (fs.existsSync(PID_FILE)) {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const oldPid = Number(raw);
    if (pidAlive(oldPid) && oldPid !== process.pid) {
      throw new Error(
        `[direct] 이미 엔진 실행 중 (pid=${oldPid}). 중복 기동 차단 — 기존 프로세스를 종료하세요.`,
      );
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
}

function releasePidLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const raw = fs.readFileSync(PID_FILE, "utf8").trim();
      if (Number(raw) === process.pid) fs.unlinkSync(PID_FILE);
    }
  } catch {
    /* ignore */
  }
}

function writeHeartbeat(extra: Record<string, unknown> = {}) {
  try {
    ensureOutDir();
    fs.writeFileSync(
      HEARTBEAT_FILE,
      JSON.stringify(
        {
          pid: process.pid,
          ticks,
          consecutiveFails,
          at: new Date().toISOString(),
          intervalMs: INTERVAL_MS,
          ...extra,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

async function pingDatabase() {
  await prisma.$queryRaw`SELECT 1`;
}

async function clearStaleTickLocks() {
  const r = await prisma.brokerAccount.updateMany({
    data: { tickLockedAt: null },
  });
  if (r.count > 0) {
    console.log(`[direct] cleared tick locks on ${r.count} account(s)`);
  }
}

async function preflight() {
  const { host } = assertTradingDatabase();
  await pingDatabase();
  await clearStaleTickLocks();
  console.log(`[direct] DB ok host=${host}`);
  return host;
}

function fatalExit(reason: unknown, code = 1): never {
  console.error(`[direct] FATAL — exiting so supervisor can restart`, reason);
  writeHeartbeat({ fatal: String(reason instanceof Error ? reason.message : reason) });
  releasePidLock();
  process.exit(code);
}

let streamRunning = false;

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
) {
  const q = [...items];
  const workers = Array.from({ length: Math.min(concurrency, q.length) }, async () => {
    while (q.length) {
      const item = q.shift();
      if (item === undefined) break;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function tradingStreamTargets() {
  const rows = await prisma.brokerAccount.findMany({
    where: {
      OR: [
        { botEnabled: true },
        { baskets: { some: { status: "open" } } },
      ],
      metaApiAccountId: { not: null },
      NOT: { status: "failed" },
    },
    select: {
      id: true,
      metaApiAccountId: true,
      metaApiRegion: true,
      baskets: { where: { status: "open" }, select: { id: true } },
    },
    take: STREAM_MAX * 2,
  });
  return rows
    .filter((r) => r.metaApiAccountId)
    .slice(0, STREAM_MAX)
    .map((r) => ({
      accountId: r.id,
      metaApiAccountId: String(r.metaApiAccountId),
      region: r.metaApiRegion,
      hasOpen: r.baskets.length > 0,
    }));
}

async function warmMetaStreams() {
  if (!isMetaStreamEnabled()) return;
  const targets = await tradingStreamTargets();
  const warmed = await warmStreams(
    targets.map((t) => ({
      metaApiAccountId: t.metaApiAccountId,
      region: t.region,
    })),
    2,
  );
  pruneStreams(new Set(targets.map((t) => t.metaApiAccountId)));
  console.log(
    `[direct] meta-stream pool=${streamPoolSize()} warmed ok=${warmed.ok} fail=${warmed.fail}`,
  );
}

async function streamOpenBasketsTick() {
  if (!STREAM_ON || streamRunning || shuttingDown) return;
  streamRunning = true;
  try {
    // Keep streaming sockets warm so runDcaTick reads terminalState (no REST credits).
    if (isMetaStreamEnabled()) {
      await warmMetaStreams().catch((e) =>
        console.warn("[stream] warm fail", e instanceof Error ? e.message : e),
      );
    }
    const targets = await tradingStreamTargets();
    // Hot path: open baskets first for DCA; bot-on without open still ticks for ENTRY.
    const ids = targets.map((t) => t.accountId);
    await mapPool(ids, STREAM_CONCURRENCY, async (id) => {
      try {
        await runDcaTick(id);
      } catch (e) {
        console.warn(
          `[stream] tick fail ${id}`,
          e instanceof Error ? e.message : e,
        );
      }
    });
  } finally {
    streamRunning = false;
  }
}

async function tick() {
  if (running || shuttingDown) return;
  running = true;
  const t0 = Date.now();
  try {
    const results = await runAllBots();
    ticks += 1;
    consecutiveFails = 0;
    const summary = JSON.stringify(results).slice(0, 600);
    console.log(
      `[direct] #${ticks} ${Date.now() - t0}ms accounts=${results.length}`,
      summary,
    );
    writeHeartbeat({
      lastMs: Date.now() - t0,
      accounts: results.length,
      ok: true,
      streamOn: STREAM_ON,
    });

    if (ticks % 3 === 0) {
      logMetaApiHttpWindow("engine-http");
      logEngineObservability("engine-obs");
      const naked = await countNakedBrokerPositions();
      const guards = await countRecentGuards(6);
      console.log(
        `[engine-obs] openBaskets=${naked.openBaskets} guards=${JSON.stringify(guards)}`,
      );
    }

    const allHardFail =
      results.length > 0 &&
      results.every(
        (r) =>
          r &&
          typeof r === "object" &&
          "ok" in r &&
          (r as { ok?: boolean }).ok === false &&
          isFatalEngineError((r as { error?: string }).error),
      );
    if (allHardFail) {
      fatalExit(results.map((r) => (r as { error?: string }).error).join("; "));
    }
  } catch (e) {
    consecutiveFails += 1;
    console.error(
      `[direct] error (${consecutiveFails}/${MAX_CONSECUTIVE_FAILS})`,
      e instanceof Error ? e.message : e,
    );
    writeHeartbeat({
      ok: false,
      error: String(e instanceof Error ? e.message : e),
    });
    if (isFatalEngineError(e) || consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      fatalExit(e);
    }
  } finally {
    running = false;
  }
}

function setupSignals() {
  const stop = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[direct] ${sig} — shutdown`);
    releasePidLock();
    void prisma.$disconnect().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("uncaughtException", (e) => fatalExit(e));
  process.on("unhandledRejection", (e) => fatalExit(e));
}

async function main() {
  setupSignals();
  acquirePidLock();
  try {
    await preflight();
  } catch (e) {
    fatalExit(e);
  }

  console.log(
    `[direct] start reconcile=${INTERVAL_MS}ms stream=${STREAM_ON ? STREAM_INTERVAL_MS + "ms" : "off"} maxOpen=${STREAM_MAX} concurrency=${STREAM_CONCURRENCY} metaStream=${isMetaStreamEnabled() ? "on" : "off"} pid=${process.pid}`,
  );
  writeHeartbeat({
    started: true,
    streamOn: STREAM_ON,
    metaStream: isMetaStreamEnabled(),
  });
  // Attach streaming sockets before first REST tick (avoids 429 burn).
  if (isMetaStreamEnabled()) {
    await warmMetaStreams().catch((e) =>
      console.warn("[direct] initial stream warm", e instanceof Error ? e.message : e),
    );
  }
  void tick();
  setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  if (STREAM_ON) {
    void streamOpenBasketsTick();
    setInterval(() => {
      void streamOpenBasketsTick();
    }, STREAM_INTERVAL_MS);
  }
}

void main();
