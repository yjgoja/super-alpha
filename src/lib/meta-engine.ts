import {
  mt5DcaAdversePct,
  mt5DcaAdverseRoi,
  mt5EntryQuote,
  mt5FloatingRoiPct,
  mt5PnlForTakeProfit,
  mt5ProfitPct,
  mt5TpMoneyTarget,
  mt5UsedMargin,
  roiToPricePct,
  shouldTriggerTakeProfit,
  spreadPct,
  triggerDropRoi,
  MT5_BROKER_LEVERAGE_DEFAULT,
} from "./dca1000";
import {
  isTableLogic,
  lotsForLogicLevel,
} from "./table-logics";
import { resolveStrategyForAccount } from "./strategy-resolve";
import {
  closePositionsBySymbol,
  fetchSnapshot,
  getSymbolPrice,
  placeMarketOrder,
  resolveBrokerSymbol,
  symbolsMatch,
} from "./metaapi";
import { dayKeySeoul, seoulDayStartUtc } from "./day-key";
import { prisma } from "./db";

function lotsAtLevel(
  startLots: number,
  multiplier: number,
  level: number,
  logic: string,
  explicitLots?: number | null,
  tableSize = 10,
) {
  if (isTableLogic(logic)) {
    return lotsForLogicLevel(logic, level, startLots, multiplier, tableSize, explicitLots);
  }
  if (logic === "dca_fixed" || logic === "grid_basic") {
    return Math.max(0.01, Math.round(startLots * 100) / 100);
  }
  const raw = startLots * Math.pow(multiplier, level);
  return Math.max(0.01, Math.round(raw * 100) / 100);
}

function avgPrice(legs: { lots: number; price: number }[]) {
  const vol = legs.reduce((s, l) => s + l.lots, 0);
  if (vol <= 0) return 0;
  return legs.reduce((s, l) => s + l.lots * l.price, 0) / vol;
}

function pnlPct(direction: "BUY" | "SELL", avg: number, bid: number, ask: number) {
  return mt5ProfitPct(direction, avg, bid, ask);
}

function adversePct(direction: "BUY" | "SELL", first: number, bid: number, ask: number) {
  if (first <= 0) return 0;
  if (direction === "BUY") {
    if (bid >= first) return 0;
    return ((first - bid) / first) * 100;
  }
  if (ask <= first) return 0;
  return ((ask - first) / first) * 100;
}

type BotCfg = {
  symbol: string;
  logic: string;
  direction: string;
  entryCount: number;
  entryMultiplier: number;
  entryIntervalPct: number;
  takeProfitPct: number;
  startLots: number;
  repeatEnabled: boolean;
  stopLossPct: number;
  stopLossEnabled: boolean;
  stopOnSl: boolean;
  /** MT5 계좌 레버 — 익절 ROI = 손익/사용증거금 */
  brokerLeverage?: number;
};

type BasketRow = {
  id: string;
  symbol: string;
  direction: string;
  filledLevel: number;
  firstEntryPrice: number;
  tradingPaused: boolean;
  legs: { level: number; lots: number; price: number }[];
};

type PosRow = {
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  price: number;
  profit: number;
};

function positionsForSymbol(positions: PosRow[], symbol: string) {
  return positions.filter((p) => symbolsMatch(p.symbol, symbol));
}

/** MT5 PC/앱에서 수동 청산 → 전체 자동매매 중지 (웹 수동청산과 동일) */
async function stopBotAfterExternalClose(accountId: string, message: string) {
  await prisma.brokerAccount.update({
    where: { id: accountId },
    data: {
      botEnabled: false,
      botStoppedAt: new Date(),
      statusMessage: message,
    },
  });
}

/**
 * DB엔 열린 바스켓이 있는데 MT5 포지션이 없음 = 터미널/외부 수동 청산.
 * 고스트 바스켓 정리 + 봇 중지. true면 이번 틱에서 주문 중단.
 */
async function detectAndStopOnExternalClose(
  accountId: string,
  baskets: BasketRow[],
  positions: PosRow[],
) {
  const ghosts = baskets.filter(
    (b) => b.legs.length > 0 && positionsForSymbol(positions, b.symbol).length === 0,
  );
  if (ghosts.length === 0) return false;

  await prisma.basket.updateMany({
    where: { id: { in: ghosts.map((g) => g.id) } },
    data: {
      status: "closed",
      lastExitAt: new Date(),
      unrealizedPnl: 0,
    },
  });
  await stopBotAfterExternalClose(
    accountId,
    "MT5 수동 청산 감지 · 자동매매 전체 중지됨",
  );
  return true;
}

/**
 * 익절: 심볼 전 포지션 일괄 청산 → DB 바스켓 종료 → (옵션) 시작로트 즉시 재진입.
 * 청산 실패 시 바스켓을 닫지 않아 다음 틱에서 재시도한다.
 */
async function closeBasketTp(opts: {
  accountId: string;
  metaId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  basket: BasketRow;
  legs: { level: number; lots: number; price: number }[];
  ourPositions: PosRow[];
  bid: number;
  ask: number;
  logic: string;
  repeatEnabled: boolean;
  /** 익절 후 재시작 로트 (보통 L0) */
  reentryLots: number;
  tpRoi: number;
  tpMoney: number;
  pnlSum: number;
  floatingRoi: number;
}) {
  const {
    accountId,
    metaId,
    symbol,
    direction,
    basket,
    legs,
    bid,
    ask,
    logic,
    repeatEnabled,
    reentryLots,
    tpRoi,
    tpMoney,
    pnlSum,
    floatingRoi,
  } = opts;

  const closeRes = await closePositionsBySymbol(metaId, symbol);
  if (!closeRes.ok || (closeRes.remaining ?? 0) > 0) {
    return {
      closed: false as const,
      reentered: false as const,
      error:
        ("message" in closeRes && closeRes.message) ||
        `${symbol} 익절 청산 실패(잔여 ${"remaining" in closeRes ? closeRes.remaining : "?"})`,
    };
  }

  await prisma.basket.update({
    where: { id: basket.id },
    data: {
      status: "closed",
      realizedPnl: pnlSum,
      lastExitAt: new Date(),
      unrealizedPnl: 0,
    },
  });
  await prisma.fill.create({
    data: {
      accountId,
      symbol,
      side: direction === "BUY" ? "SELL" : "BUY",
      lots: legs.reduce((s, l) => s + l.lots, 0),
      price: direction === "BUY" ? bid : ask,
      pnl: pnlSum,
      kind: "TP",
      note: `${logic}|roi=${floatingRoi.toFixed(1)}>=${tpRoi}|pnl=${pnlSum.toFixed(2)}/tp$${tpMoney}|legs=${opts.ourPositions.length || legs.length}`,
    },
  });
  await prisma.brokerAccount.update({
    where: { id: accountId },
    data: {
      tpCount: { increment: 1 },
      cycleCount: { increment: 1 },
    },
  });

  if (!repeatEnabled) {
    await prisma.symbolBot.updateMany({
      where: { accountId, symbol },
      data: { enabled: false },
    });
    return { closed: true as const, reentered: false as const };
  }

  // 같은 틱에서 시작 포지션 재진입 (다음 틱 의존 시 엔진 공백으로 재시작 누락 가능)
  const lots = Math.max(0.01, Math.round(reentryLots * 100) / 100);
  const order = await placeMarketOrder({
    metaApiAccountId: metaId,
    symbol,
    direction,
    lots,
    comment: `SA-${logic.replace(/[^a-z0-9_]/gi, "").slice(0, 10) || "tp"}-L0`,
  });
  if (!order.ok) {
    return {
      closed: true as const,
      reentered: false as const,
      error: order.message || "익절 후 재진입 주문 실패",
    };
  }
  const fillPrice = mt5EntryQuote(direction, bid, ask);
  await prisma.basket.create({
    data: {
      accountId,
      symbol,
      direction,
      filledLevel: 0,
      firstEntryPrice: fillPrice,
      status: "open",
      legs: { create: [{ level: 0, lots, price: fillPrice }] },
    },
  });
  await prisma.fill.create({
    data: {
      accountId,
      symbol,
      side: direction,
      lots,
      price: fillPrice,
      kind: "ENTRY",
      level: 0,
      note: `${logic}|reentry_after_tp`,
    },
  });
  return { closed: true as const, reentered: true as const };
}

/** 표 기반 DCA (1000차 / 마틴게일 / 두바이부르노) + MT5 스프레드 */
async function runSymbolTableDca(
  accountId: string,
  metaId: string,
  cfg: BotCfg,
  baskets: BasketRow[],
  positions: PosRow[],
) {
  const symbol = cfg.symbol;
  const direction = (cfg.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
  const logic = isTableLogic(cfg.logic) ? cfg.logic : "dca_1000";
  const resolved = await resolveStrategyForAccount(accountId, logic, {
    entryMultiplier: cfg.entryMultiplier,
    startLots: cfg.startLots,
  });
  const levels = resolved.levels;
  const startLots = resolved.startLots || cfg.startLots;
  const maxLevels = levels.length;
  const tag = logic.replace(/[^a-z0-9_]/gi, "").slice(0, 12) || "table";

  const levelLots = (levelIndex: number) => {
    const row = levels[levelIndex] || levels[0];
    return lotsForLogicLevel(
      logic,
      levelIndex,
      startLots,
      cfg.entryMultiplier,
      row?.size ?? 10,
      row?.lots,
    );
  };

  const price = await getSymbolPrice(metaId, symbol);
  if (!price || price.bid <= 0 || price.ask <= 0) {
    return {
      ok: false as const,
      error: `${symbol} 시세를 가져오지 못했습니다. 브로커 심볼명(GOLD 등)을 확인하세요.`,
      symbol,
      note: "no_price",
    };
  }

  const spr = spreadPct(price.bid, price.ask);
  let basket = baskets.find((b) => symbolsMatch(b.symbol, symbol));
  const ourPositions = positionsForSymbol(positions, symbol);

  // MT5 PC 등에서 수동 청산 → 고스트 바스켓. 재진입하지 않고 봇 중지
  if (basket && basket.legs.length > 0 && ourPositions.length === 0) {
    await prisma.basket.update({
      where: { id: basket.id },
      data: {
        status: "closed",
        lastExitAt: new Date(),
        unrealizedPnl: 0,
      },
    });
    await stopBotAfterExternalClose(
      accountId,
      "MT5 수동 청산 감지 · 자동매매 전체 중지됨",
    );
    return {
      ok: true as const,
      action: "external_close",
      symbol,
      note: "mt5_manual_close",
    };
  }

  if (!basket && ourPositions.length > 0) {
    const first = ourPositions[0];
    basket = await prisma.basket.create({
      data: {
        accountId,
        symbol,
        direction: first.direction,
        filledLevel: Math.max(0, ourPositions.length - 1),
        firstEntryPrice: first.price,
        status: "open",
        unrealizedPnl: ourPositions.reduce((s, p) => s + p.profit, 0),
        legs: {
          create: ourPositions.map((p, i) => ({
            level: i,
            lots: p.lots,
            price: p.price,
          })),
        },
      },
      include: { legs: true },
    });
  }

  if (basket?.tradingPaused) return { ok: true as const, note: "paused", symbol };

  if (!basket || basket.legs.length === 0) {
    if (ourPositions.length > 0) return { ok: true as const, note: "external", symbol };
    const lots = levelLots(0);
    const order = await placeMarketOrder({
      metaApiAccountId: metaId,
      symbol,
      direction,
      lots,
      comment: `SA-${tag}-L0`,
    });
    if (!order.ok) return { ok: false as const, error: order.message, symbol };
    const fillPrice = mt5EntryQuote(direction, price.bid, price.ask);
    await prisma.basket.create({
      data: {
        accountId,
        symbol,
        direction,
        filledLevel: 0,
        firstEntryPrice: fillPrice,
        status: "open",
        legs: { create: [{ level: 0, lots, price: fillPrice }] },
      },
    });
    await prisma.fill.create({
      data: {
        accountId,
        symbol,
        side: direction,
        lots,
        price: fillPrice,
        kind: "ENTRY",
        level: 0,
        note: `${logic}|spr=${spr.toFixed(4)}`,
      },
    });
    return { ok: true as const, action: "entry", symbol, spreadPct: spr };
  }

  const legs = basket.legs.sort((a, b) => a.level - b.level);
  // MT5 실포지션 평단·손익 우선
  const posVol = ourPositions.reduce((s, p) => s + p.lots, 0);
  const avg =
    posVol > 0
      ? ourPositions.reduce((s, p) => s + p.lots * p.price, 0) / posVol
      : avgPrice(legs);
  const floatingPnl = ourPositions.reduce((s, p) => s + p.profit, 0);
  const profit = mt5ProfitPct(direction, avg, price.bid, price.ask);
  const adverse = mt5DcaAdversePct(direction, basket.firstEntryPrice, price.bid, price.ask);

  // 익절: SymbolBot 우선, StrategyLogic 오버라이드 보조 (양방향 동기화됨)
  const tpRoi =
    cfg.takeProfitPct > 0
      ? cfg.takeProfitPct
      : resolved.takeProfitPct && resolved.takeProfitPct > 0
        ? resolved.takeProfitPct
        : levels[basket.filledLevel]?.profit ?? 20;
  const brokerLev = Math.max(
    1,
    cfg.brokerLeverage || MT5_BROKER_LEVERAGE_DEFAULT,
  );
  const lotsForTp = posVol > 0 ? posVol : legs.reduce((s, l) => s + l.lots, 0);
  const usedMargin = mt5UsedMargin({
    symbol,
    lots: lotsForTp,
    avgPrice: avg,
    brokerLeverage: brokerLev,
  });
  const tpMoney = mt5TpMoneyTarget({
    symbol,
    lots: lotsForTp,
    avgPrice: avg,
    tpRoiPct: tpRoi,
    brokerLeverage: brokerLev,
    bid: price.bid,
    ask: price.ask,
  });
  const pnlLegs =
    ourPositions.length > 0
      ? ourPositions.map((p) => ({ lots: p.lots, price: p.price }))
      : legs.map((l) => ({ lots: l.lots, price: l.price }));
  const tpPnl = mt5PnlForTakeProfit({
    apiProfit: floatingPnl,
    symbol,
    direction,
    legs: pnlLegs,
    bid: price.bid,
    ask: price.ask,
  });
  const floatingRoi = mt5FloatingRoiPct(tpPnl.pnl, usedMargin);
  const tpDecision = shouldTriggerTakeProfit({
    pnl: tpPnl.pnl,
    usedMargin,
    tpRoiPct: tpRoi,
  });
  // 물타기: 손실 ROI%(손익/증거금) 또는 가격역행×계좌레버 — 표 drop ROI와 비교
  const adverseRoiPrice = mt5DcaAdverseRoi(
    direction,
    basket.firstEntryPrice,
    price.bid,
    price.ask,
    brokerLev,
  );
  const lossRoi = Math.max(0, -floatingRoi);
  const adverseRoi = Math.max(lossRoi, adverseRoiPrice);

  // 익절 우선: 심볼 합산 ROI/목표$ → 전량 청산 → 재진입 (물타기·손절보다 먼저)
  if (tpDecision.hit) {
    const tpClose = await closeBasketTp({
      accountId,
      metaId,
      symbol,
      direction,
      basket,
      legs,
      ourPositions,
      bid: price.bid,
      ask: price.ask,
      logic,
      repeatEnabled: cfg.repeatEnabled,
      reentryLots: levelLots(0),
      tpRoi: tpDecision.tpRoi,
      tpMoney: tpDecision.tpMoney,
      pnlSum: tpPnl.pnl,
      floatingRoi: tpDecision.floatingRoi,
    });
    if (!tpClose.closed) {
      return {
        ok: false as const,
        error: tpClose.error || "익절 청산 실패",
        action: "tp_close_failed",
        symbol,
        tpRoi: tpDecision.tpRoi,
        tpMoney: tpDecision.tpMoney,
        floatingPnl: tpPnl.pnl,
        floatingRoi: tpDecision.floatingRoi,
        spreadPct: spr,
      };
    }
    return {
      ok: true as const,
      action: "tp",
      symbol,
      tpRoi: tpDecision.tpRoi,
      tpMoney: tpDecision.tpMoney,
      floatingPnl: tpPnl.pnl,
      floatingRoi: tpDecision.floatingRoi,
      apiProfit: tpPnl.apiProfit,
      quotePnl: tpPnl.quotePnl,
      spreadCost: tpPnl.spreadCost,
      profit,
      profitRoi: profit * 20,
      reentered: tpClose.reentered,
      reentryError: tpClose.error,
      spreadPct: spr,
    };
  }

  // 손절: ROI → 가격% (금액 손절은 별도; 기존과 동일)
  const slPricePct =
    cfg.stopLossEnabled && cfg.stopLossPct > 0 ? roiToPricePct(cfg.stopLossPct) : 0;
  if (slPricePct > 0 && profit <= -slPricePct) {
    await closePositionsBySymbol(metaId, symbol);
    const pnlSum = floatingPnl;
    await prisma.basket.update({
      where: { id: basket.id },
      data: {
        status: "closed",
        realizedPnl: pnlSum,
        lastExitAt: new Date(),
        unrealizedPnl: 0,
      },
    });
    await prisma.fill.create({
      data: {
        accountId,
        symbol,
        side: direction === "BUY" ? "SELL" : "BUY",
        lots: legs.reduce((s, l) => s + l.lots, 0),
        price: direction === "BUY" ? price.bid : price.ask,
        pnl: pnlSum,
        kind: "SL",
        note: `${logic}|roi=${(profit * 20).toFixed(1)}`,
      },
    });
    await prisma.brokerAccount.update({
      where: { id: accountId },
      data: { slCount: { increment: 1 } },
    });
    if (cfg.stopOnSl) {
      await prisma.symbolBot.updateMany({
        where: { accountId, symbol },
        data: { enabled: false },
      });
    }
    return {
      ok: true as const,
      action: "sl",
      symbol,
      profit,
      profitRoi: profit * 20,
      floatingPnl,
      spreadPct: spr,
    };
  }

  let filled = basket.filledLevel;
  let actions = 0;
  const maxPerTick = 8;
  while (filled + 1 < maxLevels && actions < maxPerTick) {
    const next = filled + 1;
    // 표 drop = ROI% — MT5 증거금 손실 ROI와 비교 (익절과 동일 정의)
    const needRoi = triggerDropRoi(next, levels);
    if (adverseRoi < needRoi) break;

    const lots = levelLots(next);
    const order = await placeMarketOrder({
      metaApiAccountId: metaId,
      symbol,
      direction,
      lots,
      comment: `SA-${tag}-L${next}`,
    });
    if (!order.ok) {
      return {
        ok: false as const,
        error: order.message,
        symbol,
        filled,
        actions,
        spreadPct: spr,
      };
    }
    const fillPrice = mt5EntryQuote(direction, price.bid, price.ask);
    await prisma.basketLeg.create({
      data: { basketId: basket.id, level: next, lots, price: fillPrice },
    });
    await prisma.fill.create({
      data: {
        accountId,
        symbol,
        side: direction,
        lots,
        price: fillPrice,
        kind: "DCA",
        level: next,
        note: `${logic}|dropRoi=${needRoi}|lossRoi=${lossRoi.toFixed(1)}|advPx=${adverseRoiPrice.toFixed(1)}|lev=${brokerLev}`,
      },
    });
    filled = next;
    actions += 1;
  }

  if (actions > 0) {
    await prisma.basket.update({
      where: { id: basket.id },
      data: {
        filledLevel: filled,
        unrealizedPnl: ourPositions.reduce((s, p) => s + p.profit, 0),
      },
    });
    return {
      ok: true as const,
      action: "dca",
      symbol,
      filled,
      actions,
      adverse,
      adverseRoi,
      spreadPct: spr,
    };
  }

  await prisma.basket.update({
    where: { id: basket.id },
    data: { unrealizedPnl: tpPnl.pnl },
  });
  return {
    ok: true as const,
    action: "hold",
    symbol,
    profit,
    profitRoi: profit * 20,
    floatingPnl: tpPnl.pnl,
    apiProfit: tpPnl.apiProfit,
    quotePnl: tpPnl.quotePnl,
    spreadCost: tpPnl.spreadCost,
    tpMoney,
    tpRoi,
    adverse,
    adverseRoi,
    nextDropRoi: filled + 1 < maxLevels ? triggerDropRoi(filled + 1, levels) : null,
    spreadPct: spr,
  };
}

async function runSymbolDca(
  accountId: string,
  metaId: string,
  cfg: BotCfg,
  baskets: BasketRow[],
  positions: PosRow[],
) {
  const logic = cfg.logic || "dca_1000";
  if (isTableLogic(logic)) {
    return runSymbolTableDca(accountId, metaId, cfg, baskets, positions);
  }

  const symbol = cfg.symbol;
  const direction = (cfg.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
  const maxLevels = Math.max(1, Math.min(20, cfg.entryCount || 10));

  const price = await getSymbolPrice(metaId, symbol);
  if (!price || price.bid <= 0) {
    return {
      ok: false as const,
      error: `${symbol} 시세를 가져오지 못했습니다.`,
      symbol,
      note: "no_price",
    };
  }

  let basket = baskets.find((b) => symbolsMatch(b.symbol, symbol));
  const ourPositions = positionsForSymbol(positions, symbol);

  if (basket && basket.legs.length > 0 && ourPositions.length === 0) {
    await prisma.basket.update({
      where: { id: basket.id },
      data: { status: "closed", lastExitAt: new Date(), unrealizedPnl: 0 },
    });
    await stopBotAfterExternalClose(
      accountId,
      "MT5 수동 청산 감지 · 자동매매 전체 중지됨",
    );
    return {
      ok: true as const,
      action: "external_close",
      symbol,
      note: "mt5_manual_close",
    };
  }

  if (!basket && ourPositions.length > 0) {
    const first = ourPositions[0];
    basket = await prisma.basket.create({
      data: {
        accountId,
        symbol,
        direction: first.direction,
        filledLevel: ourPositions.length - 1,
        firstEntryPrice: first.price,
        status: "open",
        unrealizedPnl: ourPositions.reduce((s, p) => s + p.profit, 0),
        legs: {
          create: ourPositions.map((p, i) => ({
            level: i,
            lots: p.lots,
            price: p.price,
          })),
        },
      },
      include: { legs: true },
    });
  }

  if (basket?.tradingPaused) return { ok: true as const, note: "paused", symbol };

  if (!basket || basket.legs.length === 0) {
    if (ourPositions.length > 0) return { ok: true as const, note: "external", symbol };
    const lots = lotsAtLevel(cfg.startLots, cfg.entryMultiplier, 0, logic);
    const order = await placeMarketOrder({
      metaApiAccountId: metaId,
      symbol,
      direction,
      lots,
      comment: `SA-${logic}-L0`,
    });
    if (!order.ok) return { ok: false as const, error: order.message, symbol };
    const fillPrice = direction === "BUY" ? price.ask : price.bid;
    await prisma.basket.create({
      data: {
        accountId,
        symbol,
        direction,
        filledLevel: 0,
        firstEntryPrice: fillPrice,
        status: "open",
        legs: { create: [{ level: 0, lots, price: fillPrice }] },
      },
    });
    await prisma.fill.create({
      data: {
        accountId,
        symbol,
        side: direction,
        lots,
        price: fillPrice,
        kind: "ENTRY",
        level: 0,
        note: logic,
      },
    });
    return { ok: true as const, action: "entry", symbol };
  }

  const legs = basket.legs.sort((a, b) => a.level - b.level);
  const posVol = ourPositions.reduce((s, p) => s + p.lots, 0);
  const avg =
    posVol > 0
      ? ourPositions.reduce((s, p) => s + p.lots * p.price, 0) / posVol
      : avgPrice(legs);
  const floatingPnl = ourPositions.reduce((s, p) => s + p.profit, 0);
  const profit = pnlPct(direction, avg, price.bid, price.ask);
  const adverse = adversePct(direction, basket.firstEntryPrice, price.bid, price.ask);
  const nextLevel = basket.filledLevel + 1;
  const tpRoi = cfg.takeProfitPct > 0 ? cfg.takeProfitPct : 20;
  const brokerLev = Math.max(1, cfg.brokerLeverage || MT5_BROKER_LEVERAGE_DEFAULT);
  const lotsForTp = posVol > 0 ? posVol : legs.reduce((s, l) => s + l.lots, 0);
  const usedMargin = mt5UsedMargin({
    symbol,
    lots: lotsForTp,
    avgPrice: avg,
    brokerLeverage: brokerLev,
  });
  const pnlLegs =
    ourPositions.length > 0
      ? ourPositions.map((p) => ({ lots: p.lots, price: p.price }))
      : legs.map((l) => ({ lots: l.lots, price: l.price }));
  const tpPnl = mt5PnlForTakeProfit({
    apiProfit: floatingPnl,
    symbol,
    direction,
    legs: pnlLegs,
    bid: price.bid,
    ask: price.ask,
  });
  const floatingRoi = mt5FloatingRoiPct(tpPnl.pnl, usedMargin);
  const tpDecision = shouldTriggerTakeProfit({
    pnl: tpPnl.pnl,
    usedMargin,
    tpRoiPct: tpRoi,
  });
  const adverseRoiPrice = mt5DcaAdverseRoi(
    direction,
    basket.firstEntryPrice,
    price.bid,
    price.ask,
    brokerLev,
  );
  const lossRoi = Math.max(0, -floatingRoi);
  const adverseRoi = Math.max(lossRoi, adverseRoiPrice);

  if (tpDecision.hit) {
    const tpClose = await closeBasketTp({
      accountId,
      metaId,
      symbol,
      direction,
      basket,
      legs,
      ourPositions,
      bid: price.bid,
      ask: price.ask,
      logic,
      repeatEnabled: cfg.repeatEnabled,
      reentryLots: lotsAtLevel(cfg.startLots, cfg.entryMultiplier, 0, logic),
      tpRoi: tpDecision.tpRoi,
      tpMoney: tpDecision.tpMoney,
      pnlSum: tpPnl.pnl,
      floatingRoi: tpDecision.floatingRoi,
    });
    if (!tpClose.closed) {
      return {
        ok: false as const,
        error: tpClose.error || "익절 청산 실패",
        action: "tp_close_failed",
        symbol,
      };
    }
    return {
      ok: true as const,
      action: "tp",
      symbol,
      reentered: tpClose.reentered,
      tpRoi: tpDecision.tpRoi,
      tpMoney: tpDecision.tpMoney,
      floatingPnl: tpPnl.pnl,
    };
  }

  if (cfg.stopLossEnabled && nextLevel >= maxLevels) {
    // entryIntervalPct · stopLossPct 도 코인 ROI% 로 취급 → 차트% 환산
    const slTrigger =
      roiToPricePct((cfg.entryIntervalPct || 5) * (maxLevels - 1)) +
      roiToPricePct(cfg.stopLossPct || 0);
    if (adverse >= slTrigger) {
      await closePositionsBySymbol(metaId, symbol);
      await prisma.basket.update({
        where: { id: basket.id },
        data: { status: "closed", lastExitAt: new Date() },
      });
      await prisma.brokerAccount.update({
        where: { id: accountId },
        data: { slCount: { increment: 1 } },
      });
      await prisma.fill.create({
        data: {
          accountId,
          symbol,
          side: direction === "BUY" ? "SELL" : "BUY",
          lots: legs.reduce((s, l) => s + l.lots, 0),
          price: direction === "BUY" ? price.bid : price.ask,
          kind: "SL",
          note: logic,
        },
      });
      if (cfg.stopOnSl) {
        await prisma.symbolBot.updateMany({
          where: { accountId, symbol },
          data: { enabled: false },
        });
      }
      return { ok: true as const, action: "sl", symbol };
    }
  }

  if (nextLevel < maxLevels) {
    // 물타기: 익절과 동일 — 증거금 손실 ROI / 가격역행×계좌레버 vs 간격 ROI%
    const needRoi = (cfg.entryIntervalPct || 5) * nextLevel;
    if (adverseRoi >= needRoi) {
      const lots = lotsAtLevel(cfg.startLots, cfg.entryMultiplier, nextLevel, logic);
      const order = await placeMarketOrder({
        metaApiAccountId: metaId,
        symbol,
        direction,
        lots,
        comment: `SA-${logic}-L${nextLevel}`,
      });
      if (!order.ok) return { ok: false as const, error: order.message, symbol };
      const fillPrice = direction === "BUY" ? price.ask : price.bid;
      await prisma.basketLeg.create({
        data: { basketId: basket.id, level: nextLevel, lots, price: fillPrice },
      });
      await prisma.basket.update({
        where: { id: basket.id },
        data: { filledLevel: nextLevel },
      });
      await prisma.fill.create({
        data: {
          accountId,
          symbol,
          side: direction,
          lots,
          price: fillPrice,
          kind: "DCA",
          level: nextLevel,
          note: `${logic}|needRoi=${needRoi}|lossRoi=${lossRoi.toFixed(1)}|lev=${brokerLev}`,
        },
      });
      return { ok: true as const, action: "dca", level: nextLevel, symbol };
    }
  }

  await prisma.basket.update({
    where: { id: basket.id },
    data: { unrealizedPnl: ourPositions.reduce((s, p) => s + p.profit, 0) },
  });
  return { ok: true as const, action: "hold", symbol, profit, adverse };
}

const tickLocks = new Set<string>();
const lastEquitySnapAt = new Map<string, number>();

const TICK_LOCK_STALE_MS = 90_000;

/** In-process + DB mutex so local engine / GHA / serverless don't double-trade. */
async function tryAcquireTickLock(accountId: string): Promise<boolean> {
  if (tickLocks.has(accountId)) return false;
  const staleBefore = new Date(Date.now() - TICK_LOCK_STALE_MS);
  try {
    const grabbed = await prisma.$executeRaw`
      UPDATE "BrokerAccount"
      SET "tickLockedAt" = NOW()
      WHERE "id" = ${accountId}
        AND ("tickLockedAt" IS NULL OR "tickLockedAt" < ${staleBefore})
    `;
    if (Number(grabbed) < 1) return false;
  } catch {
    // Column missing / DB flake: fall back to in-process lock only
  }
  tickLocks.add(accountId);
  return true;
}

async function releaseTickLock(accountId: string) {
  tickLocks.delete(accountId);
  try {
    await prisma.brokerAccount.update({
      where: { id: accountId },
      data: { tickLockedAt: null },
    });
  } catch {
    /* ignore */
  }
}

export async function runDcaTick(accountId: string) {
  const got = await tryAcquireTickLock(accountId);
  if (!got) {
    return { skipped: true as const, reason: "busy" };
  }
  try {
    return await runDcaTickInner(accountId);
  } finally {
    await releaseTickLock(accountId);
  }
}

async function runDcaTickInner(accountId: string) {
  const account = await prisma.brokerAccount.findUnique({
    where: { id: accountId },
    include: {
      config: true,
      symbolBots: { where: { enabled: true } },
      baskets: { where: { status: "open" }, include: { legs: true } },
    },
  });
  if (!account?.metaApiAccountId || !account.botEnabled) {
    return { skipped: true as const };
  }
  if (account.status !== "connected") {
    return { skipped: true as const, reason: "not_connected" };
  }

  const metaId = account.metaApiAccountId;
  const snap = await fetchSnapshot(metaId);
  if (!snap.ok) {
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: { statusMessage: snap.message },
    });
    return { ok: false as const, error: snap.message };
  }

  await prisma.brokerAccount.update({
    where: { id: account.id },
    data: {
      balance: snap.balance,
      equity: snap.equity,
      lastSyncAt: new Date(),
      mode: "live",
      status: "connected",
      startingBalance: account.startingBalance > 0 ? account.startingBalance : snap.balance,
      statusMessage: "클라우드 연결 · 봇 실행 중",
    },
  });

  // MT5 터미널 수동 청산: 열린 바스켓인데 포지션 없음 → 전체 중지 (심볼 루프 전)
  if (
    await detectAndStopOnExternalClose(account.id, account.baskets, snap.positions)
  ) {
    return {
      ok: true as const,
      stopped: true as const,
      reason: "mt5_manual_close",
      message: "MT5 수동 청산 감지 · 자동매매 전체 중지됨",
    };
  }

  const lastEq = lastEquitySnapAt.get(account.id) || 0;
  if (Date.now() - lastEq > 60_000) {
    lastEquitySnapAt.set(account.id, Date.now());
    await prisma.equitySnapshot.create({
      data: { accountId: account.id, equity: snap.equity, balance: snap.balance },
    });
  }

  let bots: BotCfg[] = account.symbolBots.map((b) => ({
    symbol: b.symbol,
    logic: b.logic,
    direction: b.direction,
    entryCount: b.entryCount,
    entryMultiplier: b.entryMultiplier,
    entryIntervalPct: b.entryIntervalPct,
    takeProfitPct: b.takeProfitPct,
    startLots: b.startLots,
    repeatEnabled: b.repeatEnabled,
    stopLossPct: b.stopLossPct,
    stopLossEnabled: b.stopLossEnabled,
    stopOnSl: b.stopOnSl,
    brokerLeverage: snap.leverage > 0 ? snap.leverage : MT5_BROKER_LEVERAGE_DEFAULT,
  }));

  if (bots.length === 0 && account.config) {
    const c = account.config;
    bots = [
      {
        symbol: c.symbol || "EURUSD",
        logic: "dca_1000",
        direction: c.direction || "BUY",
        entryCount: c.entryCount,
        entryMultiplier: c.entryMultiplier,
        entryIntervalPct: c.entryIntervalPct,
        takeProfitPct: c.takeProfitPct,
        startLots: c.startLots || c.baseLots,
        repeatEnabled: c.repeatEnabled,
        stopLossPct: c.stopLossPct,
        stopLossEnabled: c.stopLossEnabled,
        stopOnSl: c.stopOnSl,
        brokerLeverage: snap.leverage > 0 ? snap.leverage : MT5_BROKER_LEVERAGE_DEFAULT,
      },
    ];
  }

  // 심볼명 사전 해석 (XAU→GOLD 등) — 진입 전 캐시 워밍
  await Promise.all(bots.map((b) => resolveBrokerSymbol(metaId, b.symbol)));

  // 동일 계좌 증거금 레이스 방지: 종목 순차 처리 (TP→SL→DCA 순서는 심볼 내부)
  const results = [];
  for (const bot of bots) {
    try {
      results.push(await runSymbolDca(account.id, metaId, bot, account.baskets, snap.positions));
    } catch (e) {
      results.push({
        ok: false as const,
        symbol: bot.symbol,
        error: e instanceof Error ? e.message : "symbol tick error",
      });
    }
  }

  const failNotes = results
    .filter((r) => r && typeof r === "object" && "error" in r && (r as { error?: string }).error)
    .map((r) => `${(r as { symbol?: string }).symbol}: ${(r as { error?: string }).error}`);
  if (failNotes.length) {
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        statusMessage: `봇 실행 중 · 일부 종목 오류: ${failNotes[0]}`.slice(0, 180),
      },
    });
  }

  const day = dayKeySeoul();
  const dayFills = await prisma.fill.findMany({
    where: {
      accountId: account.id,
      createdAt: { gte: seoulDayStartUtc(day) },
    },
  });
  const dayPnl = dayFills.reduce((s, f) => s + (f.pnl || 0), 0);
  await prisma.dailyStat.upsert({
    where: { accountId_date: { accountId: account.id, date: day } },
    create: {
      accountId: account.id,
      date: day,
      startEquity: account.startingBalance || snap.equity,
      endEquity: snap.equity,
      pnl: dayPnl,
      returnPct:
        account.startingBalance > 0 ? (dayPnl / account.startingBalance) * 100 : 0,
      tpCount: dayFills.filter((f) => f.kind === "TP").length,
      slCount: dayFills.filter((f) => f.kind === "SL").length,
    },
    update: {
      endEquity: snap.equity,
      pnl: dayPnl,
      tpCount: dayFills.filter((f) => f.kind === "TP").length,
      slCount: dayFills.filter((f) => f.kind === "SL").length,
    },
  });

  return { ok: true as const, results };
}

export type RunAllBotsOpts = {
  /** Soft deadline so serverless/GHA finish before hard kill (default 52s). */
  budgetMs?: number;
  /** Cron route already undeploys idle — skip duplicate work. */
  skipIdleUndeploy?: boolean;
};

/**
 * Tick all botEnabled accounts whose owner is approved (or admin).
 * Rejected/pending owners are skipped so approval gate applies to trading too.
 */
export async function runAllBots(opts: RunAllBotsOpts = {}) {
  const { undeployIdleAccounts } = await import("./cost-optimize");
  const { ensureCloudLive } = await import("./metaapi");
  const budgetMs = opts.budgetMs ?? 52_000;
  const started = Date.now();

  if (!opts.skipIdleUndeploy) {
    try {
      await undeployIdleAccounts(24);
    } catch {
      /* ignore */
    }
  }

  const accounts = await prisma.brokerAccount.findMany({
    where: {
      botEnabled: true,
      metaApiAccountId: { not: null },
      status: { in: ["connected", "undeployed"] },
      user: {
        OR: [{ role: "admin" }, { approvalStatus: "approved" }],
      },
    },
    // Round-robin fairness: oldest tick lock / oldest update first
    orderBy: [{ tickLockedAt: "asc" }, { updatedAt: "asc" }],
    select: { id: true, status: true, metaApiAccountId: true },
  });
  const results: Array<Record<string, unknown>> = [];
  let deferred = 0;
  for (const a of accounts) {
    const elapsed = Date.now() - started;
    if (elapsed > budgetMs) {
      deferred += 1;
      results.push({ id: a.id, skipped: true, reason: "budget" });
      continue;
    }
    try {
      if (a.status === "undeployed" && a.metaApiAccountId) {
        // Cap redeploy wait so one cold account cannot starve the fleet
        const remaining = Math.max(3_000, Math.min(12_000, budgetMs - elapsed - 2_000));
        const live = await ensureCloudLive(String(a.metaApiAccountId), remaining);
        if (!live.ok) {
          results.push({
            id: a.id,
            ok: false,
            error: live.message || "redeploy failed",
          });
          continue;
        }
        await prisma.brokerAccount.update({
          where: { id: a.id },
          data: {
            status: "connected",
            botStoppedAt: null,
            statusMessage: "클라우드 재활성화 · 봇 실행 중",
          },
        });
      }
      results.push({ id: a.id, ...(await runDcaTick(a.id)) });
    } catch (e) {
      results.push({
        id: a.id,
        ok: false,
        error: e instanceof Error ? e.message : "tick error",
      });
    }
  }
  if (deferred > 0) {
    results.push({ deferred, reason: "time_budget", budgetMs });
  }
  return results;
}
