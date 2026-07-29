/**
 * Register named discovery logics on bots (enabled=false).
 * - martin_9_gbp_sell_n9 → GBPUSD SELL
 * - martin_9_xau_buy_n5 → XAUUSD BUY
 */
import { PrismaClient } from "@prisma/client";
import { logicBotDefaults } from "../src/lib/strategies";
import {
  getMartin9Defense,
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
} from "../src/lib/table-logics";

const prisma = new PrismaClient();

type Target = {
  login: string;
  logicId: "martin_9_gbp_sell_n9" | "martin_9_xau_buy_n5";
};

const TARGETS: Target[] = [
  { login: "135065717", logicId: "martin_9_gbp_sell_n9" }, // demo — GBP
  { login: "130064276", logicId: "martin_9_xau_buy_n5" }, // ~$1k — XAU
];

async function applyOne(t: Target) {
  const account = await prisma.brokerAccount.findFirst({ where: { login: t.login } });
  if (!account) return { login: t.login, ok: false, error: "no account" };

  const d = logicBotDefaults(t.logicId)!;
  const symbol = d.suggestedSymbol!;
  const direction = d.suggestedDirection!;
  const defense = getMartin9Defense(t.logicId);
  const tp = resolveLiveTakeProfitPct(t.logicId, defense?.takeProfitPct ?? 10) ?? 10;
  const sl =
    resolveLiveStopLossPct(t.logicId, defense?.stopLossPct ?? 2191.7) ?? 2191.7;

  const open = await prisma.basket.count({
    where: { accountId: account.id, symbol, direction, status: "open" },
  });

  if (open > 0) {
    // Keep OFF; do not swap ladder mid-basket
    const existing = await prisma.symbolBot.findUnique({
      where: {
        accountId_symbol_direction: {
          accountId: account.id,
          symbol,
          direction,
        },
      },
    });
    if (existing) {
      await prisma.symbolBot.update({
        where: { id: existing.id },
        data: { enabled: false },
      });
    }
    return {
      login: t.login,
      ok: false,
      frozen: true,
      logicId: t.logicId,
      symbol,
      direction,
      note: "open basket — list registered in code; bot knobs not swapped",
    };
  }

  const bot = await prisma.symbolBot.upsert({
    where: {
      accountId_symbol_direction: { accountId: account.id, symbol, direction },
    },
    create: {
      accountId: account.id,
      symbol,
      direction,
      dualDirection: false,
      enabled: false,
      logic: t.logicId,
      startLots: d.startLots,
      entryCount: d.entryCount,
      entryMultiplier: d.entryMultiplier,
      takeProfitPct: tp,
      stopLossPct: sl,
      stopLossEnabled: true,
      stopOnSl: true,
      repeatEnabled: true,
    },
    update: {
      dualDirection: false,
      enabled: false,
      logic: t.logicId,
      startLots: d.startLots,
      entryCount: d.entryCount,
      entryMultiplier: d.entryMultiplier,
      takeProfitPct: tp,
      stopLossPct: sl,
      stopLossEnabled: true,
      stopOnSl: true,
      repeatEnabled: true,
    },
  });

  return {
    login: t.login,
    ok: true,
    logicId: t.logicId,
    name: t.logicId,
    symbol,
    direction,
    enabled: bot.enabled,
    startLots: bot.startLots,
    entryMultiplier: bot.entryMultiplier,
    entryCount: bot.entryCount,
  };
}

async function main() {
  const results = [];
  for (const t of TARGETS) results.push(await applyOne(t));
  console.log(JSON.stringify({ applied: results }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
