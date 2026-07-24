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

process.env.ENGINE_MODE = "direct";

/** Reconcile interval. With open-basket stream on, default 20s; else 2s. */
const STREAM_ON =
  (process.env.STREAM_OPEN_BASKETS || "1").trim() !== "0" &&
  (process.env.STREAM_OPEN_BASKETS || "1").toLowerCase() !== "false";
const INTERVAL_MS = Math.max(
  STREAM_ON ? 5000 : 1500,
  Number(
    process.env.ENGINE_INTERVAL_MS ||
      (STREAM_ON ? 20_000 : 2000),
  ),
);
const STREAM_INTERVAL_MS = Math.max(
  500,
  Number(process.env.STREAM_OPEN_INTERVAL_MS || 800),
);
const STREAM_MAX = Math.min(
  100,
  Math.max(1, Number(process.env.STREAM_OPEN_MAX || 50)),
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

async function streamOpenBasketsTick() {
  if (!STREAM_ON || streamRunning || shuttingDown) return;
  streamRunning = true;
  try {
    const open = await prisma.basket.findMany({
      where: { status: "open" },
      select: {
        accountId: true,
        account: { select: { metaApiAccountId: true, status: true } },
      },
      take: STREAM_MAX * 3,
    });
    const ids = [
      ...new Set(
        open
          .filter((b) => b.account.metaApiAccountId && b.account.status !== "failed")
          .map((b) => b.accountId),
      ),
    ].slice(0, STREAM_MAX);
    await Promise.all(
      ids.map(async (id) => {
        try {
          await runDcaTick(id);
        } catch (e) {
          console.warn(
            `[stream] tick fail ${id}`,
            e instanceof Error ? e.message : e,
          );
        }
      }),
    );
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
    `[direct] start reconcile=${INTERVAL_MS}ms stream=${STREAM_ON ? STREAM_INTERVAL_MS + "ms" : "off"} maxOpen=${STREAM_MAX} pid=${process.pid}`,
  );
  writeHeartbeat({ started: true, streamOn: STREAM_ON });
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
