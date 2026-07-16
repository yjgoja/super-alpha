/**
 * Wire live MetaAPI account into Neon DB, enable bots, run one DCA tick,
 * and verify fills/positions increase.
 */
import { PrismaClient } from "@prisma/client";
import { runDcaTick } from "../src/lib/meta-engine";
import { fetchSnapshot } from "../src/lib/metaapi";

const prisma = new PrismaClient();
const META_ID = process.env.META_ACCOUNT_ID || "d967d9b1-5f96-4595-9e19-571db13cd234";
const LOGIN = process.env.MT5_LOGIN || "135065717";

async function main() {
  const admin = await prisma.user.findFirst({
    where: { email: "yjgoja@gmail.com" },
  });
  if (!admin) throw new Error("admin missing — run seed-admin first");

  const beforeSnap = await fetchSnapshot(META_ID);
  if (!beforeSnap.ok) throw new Error("snapshot failed: " + beforeSnap.message);
  console.log("before_positions", beforeSnap.positions.length, beforeSnap.positions);

  let account = await prisma.brokerAccount.findFirst({
    where: { OR: [{ metaApiAccountId: META_ID }, { login: LOGIN }] },
  });

  if (!account) {
    account = await prisma.brokerAccount.create({
      data: {
        userId: admin.id,
        login: LOGIN,
        passwordEnc: "linked-via-metaapi",
        server: "ZeroMarkets-Demo",
        mode: "live",
        status: "connected",
        statusMessage: "e2e linked",
        metaApiAccountId: META_ID,
        metaApiRegion: "london",
        botEnabled: true,
        botStoppedAt: null,
        balance: beforeSnap.balance,
        equity: beforeSnap.equity,
        startingBalance: beforeSnap.balance,
        lastSyncAt: new Date(),
      },
    });
    console.log("created_account", account.id);
  } else {
    account = await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        metaApiAccountId: META_ID,
        metaApiRegion: "london",
        status: "connected",
        botEnabled: true,
        botStoppedAt: null,
        balance: beforeSnap.balance,
        equity: beforeSnap.equity,
        lastSyncAt: new Date(),
      },
    });
    console.log("updated_account", account.id);
  }

  for (const symbol of ["EURUSD", "XAUUSD"]) {
    await prisma.symbolBot.upsert({
      where: {
        accountId_symbol: { accountId: account.id, symbol },
      },
      create: {
        accountId: account.id,
        symbol,
        enabled: true,
        logic: "dubai_bruno_313",
        direction: "BUY",
        entryCount: 999,
        entryMultiplier: 1,
        entryIntervalPct: 10,
        takeProfitPct: 20,
        startLots: 1,
        repeatEnabled: true,
        stopLossPct: 225,
        stopLossEnabled: true,
        stopOnSl: true,
      },
      update: {
        enabled: true,
        logic: "dubai_bruno_313",
        direction: "BUY",
        startLots: 1,
        takeProfitPct: 20,
        stopLossPct: 225,
        stopLossEnabled: true,
      },
    });
  }
  console.log("symbol_bots enabled EURUSD+XAUUSD startLots=1");

  // Clear ghost baskets so engine adopts live MT5 positions
  await prisma.basket.updateMany({
    where: { accountId: account.id, status: "open" },
    data: { status: "closed", lastExitAt: new Date() },
  });

  console.log("running runDcaTick...");
  const tick = await runDcaTick(account.id);
  console.log("tick_result", JSON.stringify(tick, null, 2));

  const fills = await prisma.fill.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  console.log(
    "recent_fills",
    fills.map((f) => ({
      kind: f.kind,
      symbol: f.symbol,
      level: f.level,
      lots: f.lots,
      note: f.note,
      at: f.createdAt,
    })),
  );

  const afterSnap = await fetchSnapshot(META_ID);
  if (!afterSnap.ok) throw new Error("after snapshot failed");
  console.log("after_positions", afterSnap.positions.length);
  for (const p of afterSnap.positions) {
    console.log(" ", p.symbol, p.direction, p.lots, p.profit);
  }

  const dcaFills = fills.filter((f) => f.kind === "DCA" || f.kind === "ENTRY");
  const posIncreased = afterSnap.positions.length > beforeSnap.positions.length;
  const lotsUp = afterSnap.positions.reduce((s, p) => s + p.lots, 0) >
    beforeSnap.positions.reduce((s, p) => s + p.lots, 0);

  const ok = dcaFills.length > 0 || posIncreased || lotsUp;
  console.log(
    JSON.stringify(
      {
        ok,
        beforePos: beforeSnap.positions.length,
        afterPos: afterSnap.positions.length,
        dcaOrEntryFills: dcaFills.length,
        lotsUp,
      },
      null,
      2,
    ),
  );
  if (!ok) {
    console.error("LIVE DCA DID NOT FIRE — inspect tick_result above");
    process.exit(1);
  }
  console.log("LIVE DCA VERIFIED");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
