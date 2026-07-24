/**
 * Open-basket stream supervisor — socket-class control plane.
 *
 * Only accounts with status=open baskets are hot-polled / streamed.
 * Full REST reconcile stays in tick-direct at a slower interval.
 *
 *   STREAM_OPEN_BASKETS=1 npm run engine:stream
 *
 * Modes:
 * - STREAM_MODE=rest (default): 400ms REST ticks for open baskets only
 * - STREAM_MODE=sdk: MetaAPI streaming connection + price poll from terminalState
 */
import { prisma } from "../src/lib/db";
import { runDcaTick } from "../src/lib/meta-engine";
import { logMetaApiHttpWindow } from "../src/lib/metaapi-metrics";
import { countNakedBrokerPositions, logEngineObservability } from "../src/lib/engine-obs";
import { assertTradingDatabase } from "../src/lib/engine-guard";

process.env.ENGINE_MODE = process.env.ENGINE_MODE || "direct";

const INTERVAL_MS = Math.max(
  200,
  Number(process.env.STREAM_OPEN_INTERVAL_MS || 400),
);
const MAX_STREAM = Math.min(
  100,
  Math.max(1, Number(process.env.STREAM_OPEN_MAX || 50)),
);
const MODE = (process.env.STREAM_MODE || "rest").toLowerCase();

let running = false;
let cycles = 0;

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () =>
      worker(),
    ),
  );
}

/** Optional SDK streaming handles — keep connections warm */
const sdkHandles = new Map<
  string,
  { close: () => void; symbols: Set<string>; lastTouch: number }
>();

async function ensureSdkStream(metaId: string, symbols: string[]) {
  const existing = sdkHandles.get(metaId);
  if (existing) {
    for (const s of symbols) existing.symbols.add(s);
    existing.lastTouch = Date.now();
    return;
  }
  const token = process.env.METAAPI_TOKEN?.trim();
  if (!token) return;
  try {
    const MetaApi = (await import("metaapi.cloud-sdk")).default as new (
      t: string,
      o?: { region?: string },
    ) => {
      metatraderAccountApi: {
        getAccount: (id: string) => Promise<{
          getStreamingConnection: () => {
            connect: () => Promise<void>;
            waitSynchronized: () => Promise<void>;
            close: () => Promise<void>;
            terminalState: { price: (sym: string) => { bid?: number; ask?: number } | null };
          };
        }>;
      };
    };
    const api = new MetaApi(token, { region: process.env.METAAPI_REGION || "london" });
    const account = await api.metatraderAccountApi.getAccount(metaId);
    const conn = account.getStreamingConnection();
    await conn.connect();
    await conn.waitSynchronized();
    const symSet = new Set(symbols);
    const timer = setInterval(() => {
      // Keep connection warm; actual decisions run in REST fast tick below
      for (const s of symSet) {
        try {
          conn.terminalState.price(s);
        } catch {
          /* ignore */
        }
      }
    }, 250);
    sdkHandles.set(metaId, {
      symbols: symSet,
      lastTouch: Date.now(),
      close: () => {
        clearInterval(timer);
        void conn.close().catch(() => null);
        sdkHandles.delete(metaId);
      },
    });
    console.log(`[stream] sdk connected meta=${metaId.slice(0, 8)}… syms=${symbols.join(",")}`);
  } catch (e) {
    console.warn(
      `[stream] sdk attach fail meta=${metaId.slice(0, 8)}…`,
      e instanceof Error ? e.message : e,
    );
  }
}

function pruneSdkStreams(activeMetaIds: Set<string>) {
  for (const [id, h] of sdkHandles) {
    if (!activeMetaIds.has(id) || Date.now() - h.lastTouch > 120_000) {
      h.close();
    }
  }
}

async function cycle() {
  if (running) return;
  running = true;
  const t0 = Date.now();
  try {
    const open = await prisma.basket.findMany({
      where: { status: "open" },
      select: {
        symbol: true,
        accountId: true,
        account: { select: { metaApiAccountId: true, status: true } },
      },
      take: MAX_STREAM * 4,
    });
    const byAccount = new Map<
      string,
      { accountId: string; metaId: string; symbols: string[] }
    >();
    for (const b of open) {
      const metaId = b.account.metaApiAccountId;
      if (!metaId || b.account.status === "failed") continue;
      const cur = byAccount.get(b.accountId);
      if (cur) {
        if (!cur.symbols.includes(b.symbol)) cur.symbols.push(b.symbol);
      } else {
        byAccount.set(b.accountId, {
          accountId: b.accountId,
          metaId,
          symbols: [b.symbol],
        });
      }
    }
    const list = [...byAccount.values()].slice(0, MAX_STREAM);
    const activeMeta = new Set(list.map((x) => x.metaId));

    if (MODE === "sdk") {
      await Promise.all(list.map((a) => ensureSdkStream(a.metaId, a.symbols)));
      pruneSdkStreams(activeMeta);
    }

    await mapPool(list, Math.min(8, list.length || 1), async (a) => {
      try {
        await runDcaTick(a.accountId);
      } catch (e) {
        console.warn(
          `[stream] tick fail account=${a.accountId}`,
          e instanceof Error ? e.message : e,
        );
      }
    });

    cycles += 1;
    if (cycles % 30 === 0) {
      logMetaApiHttpWindow("stream-http");
      logEngineObservability("stream-obs");
      const naked = await countNakedBrokerPositions();
      console.log(
        `[stream] #${cycles} openAccounts=${list.length} openBaskets=${naked.openBaskets} ${Date.now() - t0}ms mode=${MODE}`,
      );
    }
  } finally {
    running = false;
  }
}

async function main() {
  assertTradingDatabase();
  await prisma.$queryRaw`SELECT 1`;
  console.log(
    `[stream] open-basket supervisor interval=${INTERVAL_MS}ms max=${MAX_STREAM} mode=${MODE}`,
  );
  await cycle();
  setInterval(() => {
    void cycle();
  }, INTERVAL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
