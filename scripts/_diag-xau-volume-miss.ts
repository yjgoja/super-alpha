import { PrismaClient } from "@prisma/client";
import { fetchSnapshot } from "../src/lib/metaapi";
import {
  canH8Enter,
  isInH8EntryQuiet,
  minutesSinceH8Open,
  h8SessionKey,
} from "../src/lib/session-h8";

const p = new PrismaClient();

async function main() {
  const now = new Date();
  console.log({
    utc: now.toISOString(),
    h8Session: h8SessionKey(now),
    h8Quiet: isInH8EntryQuiet(now),
    h8CanEnter: canH8Enter(now),
    minsSince: minutesSinceH8Open(now),
  });

  const logins = ["130064045", "135066551", "135066766", "135067048"];
  const byId = [
    "cms2ws1mp0001v0pnbvrad9jn",
    "cms7bz0c4000ftnd55bo9tjbj",
  ];
  const accounts = await p.brokerAccount.findMany({
    where: { OR: [{ login: { in: logins } }, { id: { in: byId } }] },
    include: {
      symbolBots: true,
      baskets: { where: { status: "open" }, include: { legs: true } },
    },
  });

  for (const a of accounts) {
    const xauBots = a.symbolBots.filter((b) => /XAU|GOLD/i.test(b.symbol));
    const fills = await p.fill.findMany({
      where: {
        accountId: a.id,
        createdAt: { gte: new Date(Date.now() - 3 * 3600e3) },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
    });
    let live: string[] | string = [];
    if (a.metaApiAccountId) {
      const snap = await fetchSnapshot(a.metaApiAccountId);
      live = snap.ok
        ? snap.positions
            .filter((x) => /XAU|GOLD/i.test(x.symbol))
            .map((x) => `${x.symbol}:${x.direction}:${x.lots}`)
        : String((snap as { error?: string }).error || "snap_fail");
    }
    console.log(
      JSON.stringify(
        {
          login: a.login,
          id: a.id,
          bot: a.botEnabled,
          status: a.status,
          msg: (a.statusMessage || "").slice(0, 80),
          xauBots: xauBots.map((b) => ({
            en: b.enabled,
            logic: b.logic,
            dir: b.direction,
            lots: b.startLots,
          })),
          open: a.baskets
            .filter((b) => /XAU|GOLD/i.test(b.symbol))
            .map((b) => ({
              dir: b.direction,
              paused: b.tradingPaused,
              legs: b.legs.length,
              lots: b.legs.reduce((s, l) => s + l.lots, 0),
            })),
          liveXau: live,
          fills3h: fills.map((f) => ({
            t: f.createdAt.toISOString().slice(11, 19),
            k: f.kind,
            sym: f.symbol,
            side: f.side,
            lots: f.lots,
            n: String(f.note || "").slice(0, 90),
          })),
        },
        null,
        2,
      ),
    );
  }

  // Summary: enabled XAU + flat
  const all = await p.brokerAccount.findMany({
    where: { botEnabled: true, status: "connected" },
    include: {
      symbolBots: { where: { enabled: true } },
      baskets: { where: { status: "open" } },
    },
  });
  console.log("\n=== flat enabled XAU ===");
  for (const a of all) {
    const xau = a.symbolBots.filter((b) => /XAU|GOLD/i.test(b.symbol));
    if (!xau.length) continue;
    const open = a.baskets.filter((b) => /XAU|GOLD/i.test(b.symbol));
    if (open.length) continue;
    console.log(
      a.login,
      xau.map((b) => `${b.logic}/${b.direction}`).join(","),
    );
  }
}

main().finally(() => p.$disconnect());
