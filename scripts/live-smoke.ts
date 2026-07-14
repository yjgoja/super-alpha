/**
 * Live demo smoke test against MetaAPI (requires .env).
 * Run: npx tsx scripts/live-smoke.ts
 */
import fs from "fs";
import path from "path";

function loadEnv() {
  const p = path.join(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv();

async function main() {
  const { prisma } = await import("../src/lib/db");
  const {
    fetchSnapshot,
    getSymbolPrice,
    listBrokerSymbols,
    resolveBrokerSymbol,
  } = await import("../src/lib/metaapi");
  const { runDcaTick } = await import("../src/lib/meta-engine");

  const account = await prisma.brokerAccount.findFirst({
    where: { metaApiAccountId: { not: null }, status: "connected" },
    include: { symbolBots: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!account?.metaApiAccountId) {
    console.error("No connected account");
    process.exit(1);
  }

  console.log("account", account.login, "bot", account.botEnabled, account.metaApiAccountId);
  console.log(
    "bots",
    account.symbolBots.map((b) => `${b.symbol}:en=${b.enabled}:tp=${b.takeProfitPct}`),
  );

  const t0 = Date.now();
  const symbols = await listBrokerSymbols(account.metaApiAccountId);
  console.log("symbolCount", symbols.length, "ms", Date.now() - t0);
  console.log(
    "gold",
    symbols.filter((s) => /XAU|GOLD/i.test(s)).slice(0, 10),
  );
  console.log(
    "eur",
    symbols.filter((s) => /EURUSD/i.test(s)).slice(0, 5),
  );

  for (const logical of ["EURUSD", "XAUUSD"]) {
    const t1 = Date.now();
    const resolved = await resolveBrokerSymbol(account.metaApiAccountId, logical);
    const price = await getSymbolPrice(account.metaApiAccountId, logical);
    console.log(logical, "→", resolved, price, "ms", Date.now() - t1);
  }

  const snap = await fetchSnapshot(account.metaApiAccountId);
  if (snap.ok) {
    console.log(
      "positions",
      snap.positions.map((p) => `${p.id} ${p.symbol} ${p.direction} ${p.lots} pnl=${p.profit}`),
    );
  } else {
    console.log("snap err", snap);
  }

  const openBaskets = await prisma.basket.findMany({
    where: { accountId: account.id, status: "open" },
  });
  if (snap.ok) {
    for (const b of openBaskets) {
      const still = snap.positions.some((p) => {
        const u = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const na = u(p.symbol);
        const nb = u(b.symbol);
        const n = (x: string) => (x === "GOLD" || x.startsWith("XAU") ? "XAUUSD" : x);
        return n(na) === n(nb) || p.symbol === b.symbol;
      });
      if (!still) {
        console.log("closing orphan basket", b.symbol, b.id);
        await prisma.basket.update({
          where: { id: b.id },
          data: { status: "closed", lastExitAt: new Date(), unrealizedPnl: 0 },
        });
      }
    }
  }

  if (!account.botEnabled) {
    console.log("Enabling bot for smoke entry test...");
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: { botEnabled: true, botStoppedAt: null, status: "connected" },
    });
  }

  for (const sym of ["EURUSD", "XAUUSD"]) {
    await prisma.symbolBot.updateMany({
      where: { accountId: account.id, symbol: sym },
      data: { enabled: true },
    });
  }

  const t2 = Date.now();
  const tick = await runDcaTick(account.id);
  console.log("tick ms", Date.now() - t2);
  console.log("tick", JSON.stringify(tick, null, 2));

  const snap2 = await fetchSnapshot(account.metaApiAccountId);
  if (snap2.ok) {
    console.log(
      "positions after",
      snap2.positions.map((p) => `${p.symbol} ${p.direction} ${p.lots}`),
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
