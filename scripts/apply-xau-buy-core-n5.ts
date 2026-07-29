/**
 * Apply named logic OFF: 알파 XAU롱 코어 N5
 * Spec: XAU-BUY-D4.5-N5-tp10 / martin_9_65
 *   BUY, N=5, startLots=0.02, m=2 (table-nominal), TP=10%, SL=2191.7%
 * Does NOT enable SymbolBot or account bot — user turns ON manually.
 *
 * Important: StrategyLogic is per logicId (shared). We clear levels[] override so
 * each SymbolBot (GBP/XAU) uses its own startLots × entryMultiplier.
 *
 * Usage: npx tsx --env-file=.env scripts/apply-xau-buy-core-n5.ts
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import {
  getMartin9Defense,
  presetToEditorRows,
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
} from "../src/lib/table-logics";

const prisma = new PrismaClient();

const LOGIC_ID = "martin_9_65";
const LOGIC_NAME = "알파 XAU롱 코어 N5";
const SYMBOL = "XAUUSD";
const DIRECTION = "BUY" as const;
const START_LOTS = 0.02;
const ENTRY_MULT = 2;
const ENTRY_COUNT = 5;
/** Prefer $1k-scale flat live account; override with APPLY_LOGIN=... */
const PREFER_LOGIN = process.env.APPLY_LOGIN?.trim() || "130064276";

async function main() {
  const accounts = await prisma.brokerAccount.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      login: true,
      server: true,
      mode: true,
      status: true,
      botEnabled: true,
    },
  });
  if (!accounts.length) throw new Error("no BrokerAccount");

  const account =
    accounts.find((a) => a.login === PREFER_LOGIN) ||
    accounts.find((a) => /demo/i.test(a.server)) ||
    accounts.find((a) => ["connected", "undeployed"].includes(a.status)) ||
    accounts[0]!;

  console.log("selected:", {
    login: account.login,
    server: account.server,
    botEnabled: account.botEnabled,
  });

  const defense = getMartin9Defense(LOGIC_ID);
  const tp = resolveLiveTakeProfitPct(LOGIC_ID, defense?.takeProfitPct ?? 10) ?? 10;
  const sl =
    resolveLiveStopLossPct(LOGIC_ID, defense?.stopLossPct ?? 2191.7) ?? 2191.7;
  const preview = presetToEditorRows(LOGIC_ID, START_LOTS, ENTRY_MULT).slice(
    0,
    ENTRY_COUNT,
  );

  // Shared logicId row: name only — no levels[] (per-bot knobs on SymbolBot)
  await prisma.strategyLogic.upsert({
    where: {
      accountId_logicId: { accountId: account.id, logicId: LOGIC_ID },
    },
    create: {
      accountId: account.id,
      logicId: LOGIC_ID,
      name: LOGIC_NAME,
      payload: {
        mode: "bulk",
        takeProfitPct: tp,
        stopLossPct: sl,
      } as Prisma.InputJsonValue,
    },
    update: {
      name: LOGIC_NAME,
      payload: {
        mode: "bulk",
        takeProfitPct: tp,
        stopLossPct: sl,
      } as Prisma.InputJsonValue,
    },
  });

  const open = await prisma.basket.findMany({
    where: {
      accountId: account.id,
      symbol: SYMBOL,
      direction: DIRECTION,
      status: "open",
    },
    include: { legs: true },
  });

  const existing = await prisma.symbolBot.findUnique({
    where: {
      accountId_symbol_direction: {
        accountId: account.id,
        symbol: SYMBOL,
        direction: DIRECTION,
      },
    },
  });

  if (open.length) {
    // Fail-closed on live ladder: only force OFF, do not swap logic mid-basket
    if (existing) {
      await prisma.symbolBot.update({
        where: { id: existing.id },
        data: { enabled: false },
      });
    }
    console.log(
      JSON.stringify(
        {
          applied: false,
          frozen: true,
          reason: "OPEN_BASKET — logic/lots not changed mid-basket",
          name: LOGIC_NAME,
          intended: {
            logic: LOGIC_ID,
            startLots: START_LOTS,
            entryMultiplier: ENTRY_MULT,
            entryCount: ENTRY_COUNT,
            takeProfitPct: tp,
            stopLossPct: sl,
          },
          currentBot: existing
            ? {
                logic: existing.logic,
                startLots: existing.startLots,
                entryMultiplier: existing.entryMultiplier,
                entryCount: existing.entryCount,
                enabled: false,
              }
            : null,
          open: open.map((b) => ({
            filledLevel: b.filledLevel,
            legs: b.legs.length,
            firstEntryPrice: b.firstEntryPrice,
          })),
          levelsPreview: preview,
          note: "바스켓 청산 후 스크립트 재실행하면 설정 반영됨 (ON은 직접)",
        },
        null,
        2,
      ),
    );
    return;
  }

  const bot = await prisma.symbolBot.upsert({
    where: {
      accountId_symbol_direction: {
        accountId: account.id,
        symbol: SYMBOL,
        direction: DIRECTION,
      },
    },
    create: {
      accountId: account.id,
      symbol: SYMBOL,
      direction: DIRECTION,
      dualDirection: false,
      enabled: false,
      logic: LOGIC_ID,
      startLots: START_LOTS,
      entryCount: ENTRY_COUNT,
      entryMultiplier: ENTRY_MULT,
      takeProfitPct: tp,
      stopLossPct: sl,
      stopLossEnabled: true,
      stopOnSl: true,
      repeatEnabled: true,
    },
    update: {
      dualDirection: false,
      enabled: false,
      logic: LOGIC_ID,
      startLots: START_LOTS,
      entryCount: ENTRY_COUNT,
      entryMultiplier: ENTRY_MULT,
      takeProfitPct: tp,
      stopLossPct: sl,
      stopLossEnabled: true,
      stopOnSl: true,
      repeatEnabled: true,
    },
  });

  console.log(
    JSON.stringify(
      {
        applied: true,
        name: LOGIC_NAME,
        logicId: LOGIC_ID,
        accountLogin: account.login,
        symbol: SYMBOL,
        direction: DIRECTION,
        startLots: START_LOTS,
        entryMultiplier: ENTRY_MULT,
        entryCount: ENTRY_COUNT,
        takeProfitPct: tp,
        stopLossPct: sl,
        symbolBotEnabled: bot.enabled,
        accountBotEnabledUntouched: account.botEnabled,
        botId: bot.id,
        levelsPreview: preview,
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
  .finally(async () => {
    await prisma.$disconnect();
  });
