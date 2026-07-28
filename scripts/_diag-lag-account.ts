/**
 * One-shot: explain leg/pos lag for a basket without force-close.
 */
import { prisma } from "../src/lib/db";
import { fetchSnapshot } from "../src/lib/metaapi";

const ACCOUNT_ID = process.argv[2] || "cms2ws1mp0001v0pnbvrad9jn";

async function main() {
  const a = await prisma.brokerAccount.findUnique({
    where: { id: ACCOUNT_ID },
    select: {
      id: true,
      login: true,
      botEnabled: true,
      status: true,
      metaApiAccountId: true,
      equity: true,
      symbolBots: {
        where: { symbol: "XAUUSD" },
        select: {
          direction: true,
          enabled: true,
          logic: true,
          startLots: true,
          takeProfitPct: true,
        },
      },
      baskets: {
        where: { status: "open", symbol: "XAUUSD" },
        include: { legs: { orderBy: { level: "asc" } } },
      },
    },
  });
  if (!a) {
    console.log("account not found");
    return;
  }
  const dbLots = a.baskets.reduce(
    (s, b) => s + b.legs.reduce((ss, l) => ss + l.lots, 0),
    0,
  );
  console.log(
    `login=${a.login} equity=${a.equity} bot=${a.botEnabled} status=${a.status}`,
  );
  console.log(
    "bots",
    a.symbolBots
      .map((b) => `${b.enabled ? "ON" : "off"} ${b.direction} ${b.logic} L0=${b.startLots} TP=${b.takeProfitPct}`)
      .join(" | "),
  );
  for (const b of a.baskets) {
    console.log(
      `basket ${b.direction} filled=${b.filledLevel} legs=${b.legs.length} dbLots=${b.legs
        .reduce((s, l) => s + l.lots, 0)
        .toFixed(2)} uPnL=${b.unrealizedPnl}`,
    );
  }

  if (!a.metaApiAccountId) return;
  const snap = await fetchSnapshot(a.metaApiAccountId);
  if (!snap.ok) {
    console.log("LIVE SNAP FAIL", JSON.stringify(snap));
    return;
  }
  const xau = snap.positions.filter((p) =>
    String(p.symbol || "")
      .toUpperCase()
      .includes("XAU"),
  );
  console.log(
    "LIVE",
    xau.map((p) => `${p.direction} ${p.lots}@${p.price} pnl=${p.profit}`),
  );
  console.log(
    `SUMMARY dbLegs=${a.baskets.reduce((s, b) => s + b.legs.length, 0)} dbLots=${dbLots.toFixed(2)} livePos=${xau.length} liveLots=${xau
      .reduce((s, p) => s + p.lots, 0)
      .toFixed(2)}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
