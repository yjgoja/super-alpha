import { prisma } from "./db";
import {
  adversePercent,
  estimateBasketPnl,
  finalStopPct,
  lotsForLevel,
  scaledDeviation,
} from "./dca";
import { dayKeySeoul } from "./day-key";
import { getPrices, refreshPrices } from "./prices";

function todayKey() {
  return dayKeySeoul();
}

async function ensureDaily(accountId: string, equity: number) {
  const date = todayKey();
  const existing = await prisma.dailyStat.findUnique({
    where: { accountId_date: { accountId, date } },
  });
  if (!existing) {
    await prisma.dailyStat.create({
      data: {
        accountId,
        date,
        startEquity: equity,
        endEquity: equity,
      },
    });
  }
}

async function bumpDaily(
  accountId: string,
  equity: number,
  kind?: "TP" | "SL",
) {
  const date = todayKey();
  await ensureDaily(accountId, equity);
  const row = await prisma.dailyStat.findUniqueOrThrow({
    where: { accountId_date: { accountId, date } },
  });
  const pnl = equity - row.startEquity;
  const returnPct = row.startEquity ? (pnl / row.startEquity) * 100 : 0;
  await prisma.dailyStat.update({
    where: { id: row.id },
    data: {
      endEquity: equity,
      pnl,
      returnPct,
      tpCount: kind === "TP" ? row.tpCount + 1 : row.tpCount,
      slCount: kind === "SL" ? row.slCount + 1 : row.slCount,
    },
  });
}

function pickDirection(): "BUY" | "SELL" {
  return Math.random() > 0.5 ? "BUY" : "SELL";
}

export async function runEngineTick() {
  const prices = await refreshPrices();

  const accounts = await prisma.brokerAccount.findMany({
    where: { botEnabled: true, status: "connected" },
    include: { config: true, baskets: { where: { status: "open" }, include: { legs: true } } },
  });

  for (const account of accounts) {
    const cfg = account.config;
    if (!cfg) continue;
    const symbols = cfg.symbols.split(",").map((s) => s.trim()).filter(Boolean);

    let equity = account.balance;
    for (const b of account.baskets) {
      const q = prices[b.symbol];
      if (!q) continue;
      const pnl = estimateBasketPnl(
        b.symbol,
        b.direction as "BUY" | "SELL",
        b.legs,
        q.bid,
        q.ask,
      );
      equity += pnl;
      await prisma.basket.update({
        where: { id: b.id },
        data: { unrealizedPnl: pnl },
      });
    }

    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: { equity },
    });
    await ensureDaily(account.id, equity);

    for (const symbol of symbols) {
      await processSymbol(account.id, symbol, prices, cfg, equity);
    }

    const fresh = await prisma.brokerAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: {
        baskets: { where: { status: "open" }, include: { legs: true } },
      },
    });

    let eq = fresh.balance;
    for (const b of fresh.baskets) {
      const q = prices[b.symbol];
      if (!q) continue;
      eq += estimateBasketPnl(
        b.symbol,
        b.direction as "BUY" | "SELL",
        b.legs,
        q.bid,
        q.ask,
      );
    }
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: { equity: eq },
    });
    await bumpDaily(account.id, eq);
    await prisma.equitySnapshot.create({
      data: { accountId: account.id, equity: eq, balance: fresh.balance },
    });
  }
}

async function processSymbol(
  accountId: string,
  symbol: string,
  prices: Record<string, { bid: number; ask: number }>,
  cfg: {
    baseLots: number;
    profitTarget: number;
    profitScale: number;
    maxDcaLevel: number;
    devScale: number;
    finalSlExtraPct: number;
    enableFinalSl: boolean;
    reenterAfterTp: boolean;
    reenterAfterSl: boolean;
  },
  _equityHint: number,
) {
  const q = prices[symbol] ?? (await getPrices())[symbol];
  if (!q) return;

  const account = await prisma.brokerAccount.findUniqueOrThrow({
    where: { id: accountId },
  });

  let basket = await prisma.basket.findFirst({
    where: { accountId, symbol, status: "open" },
    include: { legs: { orderBy: { level: "asc" } } },
  });

  // Manage exits
  if (basket) {
    const pnl = estimateBasketPnl(
      symbol,
      basket.direction as "BUY" | "SELL",
      basket.legs,
      q.bid,
      q.ask,
    );
    const tp = cfg.profitTarget * cfg.profitScale;
    const adv = adversePercent(
      basket.direction as "BUY" | "SELL",
      basket.firstEntryPrice,
      q.bid,
      q.ask,
    );
    const maxLv = Math.min(cfg.maxDcaLevel, 9);
    const slLine = finalStopPct(maxLv, cfg.devScale, cfg.finalSlExtraPct);

    if (pnl >= tp) {
      await closeBasket(basket.id, "TP", pnl, q, cfg.reenterAfterTp);
      return;
    }
    if (
      cfg.enableFinalSl &&
      basket.filledLevel >= maxLv &&
      adv + 1e-8 >= slLine
    ) {
      await closeBasket(basket.id, "SL", pnl, q, cfg.reenterAfterSl);
      return;
    }
  }

  // Re-read after possible close
  basket = await prisma.basket.findFirst({
    where: { accountId, symbol, status: "open" },
    include: { legs: { orderBy: { level: "asc" } } },
  });

  const paused = await prisma.basket.findFirst({
    where: {
      accountId,
      symbol,
      tradingPaused: true,
      status: { in: ["closed_tp", "closed_sl"] },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (paused?.tradingPaused) return;

  if (!basket) {
    // Open initial
    const direction = pickDirection();
    const price = direction === "BUY" ? q.ask : q.bid;
    const lots = lotsForLevel(cfg.baseLots, 0);
    const created = await prisma.basket.create({
      data: {
        accountId,
        symbol,
        direction,
        filledLevel: 0,
        firstEntryPrice: price,
        status: "open",
        legs: { create: [{ level: 0, lots, price }] },
      },
    });
    await prisma.fill.create({
      data: {
        accountId,
        symbol,
        side: direction,
        lots,
        price,
        kind: "ENTRY",
        level: 0,
        note: "L0",
      },
    });
    await prisma.brokerAccount.update({
      where: { id: accountId },
      data: { cycleCount: account.cycleCount + 1 },
    });
    void created;
    return;
  }

  // DCA
  const maxLv = Math.min(cfg.maxDcaLevel, 9);
  if (basket.filledLevel >= maxLv) return;

  const adv = adversePercent(
    basket.direction as "BUY" | "SELL",
    basket.firstEntryPrice,
    q.bid,
    q.ask,
  );
  const next = basket.filledLevel + 1;
  if (adv + 1e-8 < scaledDeviation(next, cfg.devScale)) return;

  const lots = lotsForLevel(cfg.baseLots, next);
  const price = basket.direction === "BUY" ? q.ask : q.bid;
  await prisma.basketLeg.create({
    data: { basketId: basket.id, level: next, lots, price },
  });
  await prisma.basket.update({
    where: { id: basket.id },
    data: { filledLevel: next },
  });
  await prisma.fill.create({
    data: {
      accountId,
      symbol,
      side: basket.direction,
      lots,
      price,
      kind: "DCA",
      level: next,
      note: `L${next}`,
    },
  });
}

async function closeBasket(
  basketId: string,
  kind: "TP" | "SL",
  pnl: number,
  q: { bid: number; ask: number },
  reenter: boolean,
) {
  const basket = await prisma.basket.findUniqueOrThrow({
    where: { id: basketId },
    include: { legs: true },
  });
  const mark = basket.direction === "BUY" ? q.bid : q.ask;
  const totalLots = basket.legs.reduce((s, l) => s + l.lots, 0);

  await prisma.basket.update({
    where: { id: basketId },
    data: {
      status: kind === "TP" ? "closed_tp" : "closed_sl",
      realizedPnl: pnl,
      unrealizedPnl: 0,
      tradingPaused: !reenter,
      lastExitAt: new Date(),
    },
  });

  const account = await prisma.brokerAccount.update({
    where: { id: basket.accountId },
    data: {
      balance: { increment: pnl },
      ...(kind === "TP"
        ? { tpCount: { increment: 1 } }
        : { slCount: { increment: 1 } }),
    },
  });

  await prisma.fill.create({
    data: {
      accountId: basket.accountId,
      symbol: basket.symbol,
      side: basket.direction === "BUY" ? "SELL" : "BUY",
      lots: totalLots,
      price: mark,
      pnl,
      kind,
      note: kind === "TP" ? "익절" : "손절",
    },
  });

  await bumpDaily(basket.accountId, account.balance, kind);
}
