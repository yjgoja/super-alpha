import { PrismaClient } from "@prisma/client";
import {
  isFxMarketClosed,
  isInOpenBurstQuietPeriod,
} from "../src/lib/market-hours";
import {
  brokerParts,
  canH8Enter,
  h8SessionKey,
  isH8OpenMinute,
  isInH8EntryQuiet,
  minutesSinceH8Open,
} from "../src/lib/session-h8";
import { isMartin9TimeLogic } from "../src/lib/table-logics";

const p = new PrismaClient();

async function main() {
  const now = new Date();
  const bp = brokerParts(now);
  console.log(
    JSON.stringify(
      {
        utc: now.toISOString(),
        brokerMins: bp.minutesOfDay,
        fxClosed: isFxMarketClosed(now),
        burst: isInOpenBurstQuietPeriod(now),
        h8Session: h8SessionKey(now),
        h8OpenMin: isH8OpenMinute(now),
        h8Quiet: isInH8EntryQuiet(now),
        h8CanEnter: canH8Enter(now),
        minsSince: minutesSinceH8Open(now),
      },
      null,
      2,
    ),
  );

  const since = new Date(Date.now() - 24 * 3600e3);
  const rows = await p.brokerAccount.findMany({
    where: { botEnabled: true },
    include: {
      symbolBots: { where: { enabled: true } },
      baskets: { where: { status: "open" } },
    },
  });

  console.log("\n=== enabled XAU bots (master ON) ===");
  for (const a of rows) {
    const xau = a.symbolBots.filter((b) => /XAU|GOLD/i.test(b.symbol));
    if (!xau.length) continue;
    const open = a.baskets.filter((b) => /XAU|GOLD/i.test(b.symbol));
    const fills = await p.fills.count({
      where: {
        accountId: a.id,
        createdAt: { gte: since },
        symbol: { contains: "XAU", mode: "insensitive" },
        kind: { in: ["ENTRY", "DCA", "TP"] },
      },
    });
    const recent = await p.fills.findMany({
      where: {
        accountId: a.id,
        createdAt: { gte: new Date(Date.now() - 2 * 3600e3) },
        OR: [
          { symbol: { contains: "XAU", mode: "insensitive" } },
          { kind: "GUARD" },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    console.log(
      JSON.stringify({
        login: a.login,
        status: a.status,
        logics: xau.map((b) => ({
          logic: b.logic,
          dir: b.direction,
          time: isMartin9TimeLogic(b.logic),
          lots: b.startLots,
        })),
        openXau: open.map((b) => ({
          dir: b.direction,
          paused: b.tradingPaused,
          lvl: b.filledLevel,
        })),
        fills24h: fills,
        recent: recent.map((f) => ({
          t: f.createdAt.toISOString().slice(11, 19),
          k: f.kind,
          s: f.symbol,
          n: String(f.note || "").slice(0, 70),
        })),
      }),
    );
  }
}

main().finally(() => p.$disconnect());
