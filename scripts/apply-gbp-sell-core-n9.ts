/**
 * Apply named test logic: 알파 GBP숏 코어 N9
 * Spec from discovery GBP-SELL-D2.5-N9-tp10 / martin_9_65
 *   direction SELL, N=9, startLots=0.05, m=1.7, TP=10%, SL=preset 2191.7%
 *
 * Usage: npx tsx --env-file=.env scripts/apply-gbp-sell-core-n9.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  getMartin9Defense,
  presetToEditorRows,
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
} from "../src/lib/table-logics";

const prisma = new PrismaClient();

const LOGIC_ID = "martin_9_65";
const LOGIC_NAME = "알파 GBP숏 코어 N9";
const SYMBOL = "GBPUSD";
const DIRECTION = "SELL" as const;
const START_LOTS = 0.05;
const ENTRY_MULT = 1.7;
const ENTRY_COUNT = 9;

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
      balance: true,
      equity: true,
    },
  });
  if (!accounts.length) throw new Error("no BrokerAccount");

  console.log(
    "accounts:",
    accounts.map((a) => ({
      login: a.login,
      server: a.server,
      mode: a.mode,
      status: a.status,
      botEnabled: a.botEnabled,
      balance: a.balance,
    })),
  );

  // Prefer connected demo; else most recently updated connected/undeployed
  const account =
    accounts.find(
      (a) =>
        (/demo/i.test(a.server) || a.mode === "demo") &&
        ["connected", "undeployed", "provisioning"].includes(a.status),
    ) ||
    accounts.find((a) => ["connected", "undeployed"].includes(a.status)) ||
    accounts[0]!;

  console.log("selected account:", {
    login: account.login,
    server: account.server,
    mode: account.mode,
    status: account.status,
    botEnabled: account.botEnabled,
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
  if (open.length) {
    console.error(
      "OPEN_BASKET_FROZEN — will NOT change logic/lots mid-basket:",
      open.map((b) => ({
        id: b.id,
        filledLevel: b.filledLevel,
        legs: b.legs.length,
        firstEntryPrice: b.firstEntryPrice,
      })),
    );
    // Still allow enabling bot + ensure bot row exists without mutating ladder knobs
    const existing = await prisma.symbolBot.findUnique({
      where: {
        accountId_symbol_direction: {
          accountId: account.id,
          symbol: SYMBOL,
          direction: DIRECTION,
        },
      },
    });
    if (existing) {
      await prisma.symbolBot.update({
        where: { id: existing.id },
        data: { enabled: true },
      });
      if (!account.botEnabled) {
        await prisma.brokerAccount.update({
          where: { id: account.id },
          data: { botEnabled: true, botStoppedAt: null },
        });
      }
      console.log("enabled existing bot only (ladder frozen). existing:", {
        logic: existing.logic,
        startLots: existing.startLots,
        entryMultiplier: existing.entryMultiplier,
        entryCount: existing.entryCount,
      });
    }
    process.exit(2);
  }

  const defense = getMartin9Defense(LOGIC_ID);
  const tp = resolveLiveTakeProfitPct(LOGIC_ID, defense?.takeProfitPct ?? 10) ?? 10;
  const sl =
    resolveLiveStopLossPct(LOGIC_ID, defense?.stopLossPct ?? 2191.7) ?? 2191.7;
  const rows = presetToEditorRows(LOGIC_ID, START_LOTS, ENTRY_MULT).slice(
    0,
    ENTRY_COUNT,
  );

  const payload = {
    mode: "levels" as const,
    startLots: START_LOTS,
    takeProfitPct: tp,
    stopLossPct: sl,
    levels: rows.map((r) => ({
      lots: r.lots,
      profit: tp,
      drop: r.drop,
    })),
  };

  await prisma.strategyLogic.upsert({
    where: {
      accountId_logicId: { accountId: account.id, logicId: LOGIC_ID },
    },
    create: {
      accountId: account.id,
      logicId: LOGIC_ID,
      name: LOGIC_NAME,
      payload,
    },
    update: {
      name: LOGIC_NAME,
      payload,
    },
  });

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
      enabled: true,
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
      enabled: true,
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

  await prisma.brokerAccount.update({
    where: { id: account.id },
    data: {
      botEnabled: true,
      botStoppedAt: null,
      statusMessage: `${LOGIC_NAME} 적용 · ${SYMBOL} ${DIRECTION} · 테스트`,
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
        botId: bot.id,
        levels: payload.levels,
        note: "장중이면 엔진 틱에서 조건 없이 L0 시장가 진입",
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
