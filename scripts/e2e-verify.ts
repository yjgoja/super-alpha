/**
 * End-to-end verification: DB + DCA math + (optional) live cron/engine.
 * Run: npx tsx --env-file=.env scripts/e2e-verify.ts
 */
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import {
  mt5UsedMargin,
  mt5TpMoneyTarget,
  mt5FloatingRoiPct,
  mt5DcaAdverseRoi,
  mt5DcaAdversePct,
  triggerDropRoi,
  DCA1000_LEVELS,
  MT5_BROKER_LEVERAGE_DEFAULT,
} from "../src/lib/dca1000";

const prisma = new PrismaClient();
const LEV = MT5_BROKER_LEVERAGE_DEFAULT;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("PASS:", msg);
  }
}

async function seedAdmin() {
  const email = (process.env.ADMIN_EMAILS || "yjgoja@gmail.com")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || "SuperAlpha!2026";
  const passwordHash = await hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: "Admin",
      passwordHash,
      role: "admin",
      approvalStatus: "approved",
    },
    update: {
      passwordHash,
      role: "admin",
      approvalStatus: "approved",
    },
  });
  return { email: user.email, id: user.id, password };
}

async function main() {
  console.log("=== 1) DB connectivity ===");
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`;
  const names = tables.map((t) => t.tablename);
  console.log("tables:", names.join(", "));
  assert(names.includes("User"), "User table");
  assert(names.includes("SymbolBot"), "SymbolBot table");
  assert(names.includes("StrategyLogic"), "StrategyLogic table");
  assert(names.includes("Basket"), "Basket table");

  console.log("\n=== 2) Admin seed + login path ===");
  const admin = await seedAdmin();
  assert(!!admin.id, "admin seeded " + admin.email);

  console.log("\n=== 3) DCA/TP math (screenshot XAU/EUR 1 lot) ===");
  const xau = {
    symbol: "XAUUSD",
    entry: 4080.18,
    bid: 4060.28,
    ask: 4060.48,
    lots: 1,
    pnl: -1990,
  };
  const eur = {
    symbol: "EURUSD",
    entry: 1.14491,
    bid: 1.14288,
    ask: 1.14298,
    lots: 1,
    pnl: -203,
  };

  for (const c of [xau, eur]) {
    const margin = mt5UsedMargin({
      symbol: c.symbol,
      lots: c.lots,
      avgPrice: c.entry,
      brokerLeverage: LEV,
    });
    const tpMoney = mt5TpMoneyTarget({
      symbol: c.symbol,
      lots: c.lots,
      avgPrice: c.entry,
      tpRoiPct: 20,
      brokerLeverage: LEV,
    });
    const lossRoi = Math.max(0, -mt5FloatingRoiPct(c.pnl, margin));
    const adv500 = mt5DcaAdverseRoi("BUY", c.entry, c.bid, c.ask, LEV);
    const adv20 = mt5DcaAdverseRoi("BUY", c.entry, c.bid, c.ask, 20);
    const adverse = Math.max(lossRoi, adv500);
    const needL1 = triggerDropRoi(1, DCA1000_LEVELS);

    let filled = 0;
    let actions = 0;
    while (filled + 1 < DCA1000_LEVELS.length && actions < 8) {
      const next = filled + 1;
      if (adverse < triggerDropRoi(next, DCA1000_LEVELS)) break;
      filled = next;
      actions += 1;
    }

    console.log(
      JSON.stringify(
        {
          symbol: c.symbol,
          margin: +margin.toFixed(2),
          tpMoney,
          lossRoi: +lossRoi.toFixed(1),
          oldX20: +adv20.toFixed(1),
          newAdverse: +adverse.toFixed(1),
          needL1,
          wouldDcaOld: adv20 >= needL1,
          wouldDcaNew: adverse >= needL1,
          dcaLevelsThisTick: actions,
        },
        null,
        2,
      ),
    );
    assert(adverse >= needL1, `${c.symbol} NEW logic must DCA`);
    assert(adv20 < needL1, `${c.symbol} OLD x20 would miss (bug explained)`);
    assert(actions === 8, `${c.symbol} catches up 8 levels/tick`);
    assert(c.pnl < tpMoney, `${c.symbol} not at TP while deep loss`);
  }

  console.log("\n=== 4) First DCA money thresholds (1 lot) ===");
  const xauM = mt5UsedMargin({
    symbol: "XAUUSD",
    lots: 1,
    avgPrice: 4080.18,
    brokerLeverage: LEV,
  });
  const need1 = triggerDropRoi(1, DCA1000_LEVELS);
  const usd1 = +(xauM * (need1 / 100)).toFixed(2);
  console.log({ firstDropRoi: need1, xauLossUsdToDca: usd1, pricePct: need1 / LEV });
  assert(usd1 > 50 && usd1 < 120, "XAU L1 DCA around $81");

  console.log("\n=== 5) Live cron ===");
  const secret = process.env.CRON_SECRET || "";
  const tickUrl =
    process.env.TICK_URL || "https://super-alpha-inky.vercel.app/api/cron/tick";
  if (!secret) {
    assert(false, "CRON_SECRET missing");
  } else {
    const res = await fetch(tickUrl, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(55_000),
    });
    const body = await res.text();
    console.log("cron", res.status, body.slice(0, 300));
    assert(res.status === 200, "cron HTTP 200");
    assert(body.includes('"ok":true'), "cron ok:true");
  }

  console.log("\n=== 6) Prod auth ===");
  const authRes = await fetch("https://super-alpha-inky.vercel.app/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: admin.email,
      password: admin.password,
      mode: "login",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const authBody = await authRes.text();
  console.log("auth", authRes.status, authBody.slice(0, 200));
  assert(authRes.status === 200, "prod login 200");

  console.log("\n=== 7) Open bots/baskets ===");
  const bots = await prisma.symbolBot.findMany();
  const baskets = await prisma.basket.findMany({ where: { status: "open" } });
  const accounts = await prisma.brokerAccount.findMany({
    select: {
      id: true,
      login: true,
      botEnabled: true,
      status: true,
      metaApiAccountId: true,
    },
  });
  console.log({ bots: bots.length, baskets: baskets.length, accounts });

  if (failed) {
    console.error("\nFAILED assertions:", failed);
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED");
  console.log(
    JSON.stringify(
      {
        adminLogin: { email: admin.email, password: admin.password },
        note:
          "accounts=0 until MT5 connected + bot ON. DCA math verified for deep-loss screenshot cases.",
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
