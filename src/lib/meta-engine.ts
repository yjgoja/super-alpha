import {
  liveBasketTpSlUsd,
  mt5EntryQuote,
  mt5FloatingRoiPct,
  mt5PnlForTakeProfit,
  mt5ProfitPct,
  shouldTriggerDcaRoi,
  shouldTriggerStopLossUsd,
  shouldTriggerTakeProfit,
  spreadPct,
  MT5_BROKER_LEVERAGE_DEFAULT,
  DCA1000_DEFAULT_SL_ROI,
} from "./dca1000";
import {
  isBulkLogic,
  isTableLogic,
  lotsForLogicLevel,
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
} from "./table-logics";
import { normalizeLogicId } from "./strategies";
import { resolveStrategyForAccount } from "./strategy-resolve";
import {
  closePositionsBySymbolDirection,
  ensureAccountCloudLive,
  ensureCloudLive,
  fetchSnapshot,
  getSymbolPrice,
  placeMarketOrder,
  resolveBrokerSymbol,
  symbolsMatch,
} from "./metaapi";
import { prisma } from "./db";
import { isCloudColdError } from "./engine-guard";
import { syncTodayPnlFromMt5Deals } from "./mt5-pnl-sync";

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

type BotCfg = {
  symbol: string;
  logic: string;
  direction: string;
  /** 양방향: 같은 종목에 BUY·SELL 바스켓을 동시에 운용 */
  dualDirection?: boolean;
  entryCount: number;
  entryMultiplier: number;
  entryIntervalPct: number;
  takeProfitPct: number;
  /** 고정 익절 목표($). 0이면 startLots 증거금×ROI%로 환산 */
  takeProfitUsd: number;
  startLots: number;
  repeatEnabled: boolean;
  stopLossPct: number;
  /** 고정 손절 한도($). 0이면 startLots 증거금×ROI%로 환산 */
  stopLossUsd: number;
  stopLossEnabled: boolean;
  stopOnSl: boolean;
  /** MT5 계좌 레버 — 시작로트 증거금/$ 환산 */
  brokerLeverage?: number;
  /**
   * true: 종목/전체 OFF 등으로 신규 진입·물타기·재진입 금지.
   * 열린 바스켓의 익절·손절만 관리 (토글 스팸으로 포지션이 방치되는 사고 방지).
   */
  manageOnly?: boolean;
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
  margin?: number;
};

function positionsForSymbol(
  positions: PosRow[],
  symbol: string,
  direction?: "BUY" | "SELL",
) {
  return positions.filter(
    (p) => symbolsMatch(p.symbol, symbol) && (!direction || p.direction === direction),
  );
}

/** 신규 진입·물타기·익절후재진입 허용 여부 (틱 중 토글 반영) */
async function canOpenNewRisk(
  accountId: string,
  symbol: string,
  direction: "BUY" | "SELL",
) {
  const [account, bots] = await Promise.all([
    prisma.brokerAccount.findUnique({
      where: { id: accountId },
      select: { botEnabled: true },
    }),
    prisma.symbolBot.findMany({
      where: { accountId, symbol },
      select: { enabled: true, direction: true, dualDirection: true },
    }),
  ]);
  if (!account?.botEnabled) return false;
  return bots.some((b) => {
    if (!b.enabled) return false;
    if (b.dualDirection) return true;
    return (b.direction === "SELL" ? "SELL" : "BUY") === direction;
  });
}

/** 손절후중지 / 익절후미반복 — dualDirection 행까지 함께 끔 */
async function disableSymbolBotSide(
  accountId: string,
  symbol: string,
  direction: "BUY" | "SELL",
) {
  await prisma.symbolBot.updateMany({
    where: {
      accountId,
      symbol,
      OR: [{ direction }, { dualDirection: true }],
    },
    data: { enabled: false },
  });
}

/** 웹 수동청산 API 등에서만 사용. 엔진 고스트 감지에서는 호출하지 않음. */
export async function stopBotAfterManualClose(accountId: string, message: string) {
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
 * DB엔 열린 바스켓이 있는데 MT5 포지션이 없음 = 동기화 불일치(API 지연·이미 청산됨).
 * 바스켓만 DB에서 닫고 봇은 절대 끄지 않는다. (오탐으로 전체 중지하던 버그 제거)
 * true면 심볼 루프는 계속 진행(신규 진입/익절·손절 유지).
 */
async function healGhostBaskets(
  accountId: string,
  metaId: string,
  baskets: BasketRow[],
  positions: PosRow[],
  opts?: { skip?: boolean; margin?: number; equity?: number; balance?: number },
) {
  if (opts?.skip) return false;

  const ghosts = baskets.filter(
    (b) =>
      b.legs.length > 0 &&
      positionsForSymbol(positions, b.symbol, b.direction === "SELL" ? "SELL" : "BUY")
        .length === 0,
  );
  if (ghosts.length === 0) return false;

  // Used margin / equity drawdown → positions almost certainly still open (API lag)
  const margin = opts?.margin ?? 0;
  const equity = opts?.equity ?? 0;
  const balance = opts?.balance ?? 0;
  if (margin > 1 || (balance > 0 && equity > 0 && Math.abs(balance - equity) > 1)) {
    console.warn(
      `[engine] skip ghost-heal account=${accountId} margin=${margin} eq=${equity} bal=${balance}`,
    );
    return false;
  }

  // Confirm with a second snapshot (MetaAPI can return [] briefly after deploy)
  await new Promise((r) => setTimeout(r, 1500));
  const again = await fetchSnapshot(metaId);
  if (!again.ok) return false;
  const stillGhost = ghosts.filter(
    (b) =>
      positionsForSymbol(
        again.positions,
        b.symbol,
        b.direction === "SELL" ? "SELL" : "BUY",
      ).length === 0,
  );
  if (stillGhost.length === 0) return false;

  const againMargin = Number(again.margin ?? 0);
  if (
    againMargin > 1 ||
    (again.balance > 0 &&
      again.equity > 0 &&
      Math.abs(again.balance - again.equity) > 1)
  ) {
    return false;
  }

  await prisma.basket.updateMany({
    where: { id: { in: stillGhost.map((g) => g.id) } },
    data: {
      status: "closed",
      lastExitAt: new Date(),
      unrealizedPnl: 0,
    },
  });
  console.warn(
    `[engine] healed ${stillGhost.length} ghost basket(s) account=${accountId} — bot stays ON`,
  );
  // Keep botEnabled. Do not call stopBotAfterExternalClose.
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
  /** manageOnly / 토글 OFF 시 재진입 금지 */
  allowReentry?: boolean;
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
    allowReentry = true,
  } = opts;

  const closeRes = await closePositionsBySymbolDirection(metaId, symbol, direction);
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
      note: `${logic}|pnl=${pnlSum.toFixed(2)}>=tp$${tpMoney}|roi=${floatingRoi.toFixed(1)}~${tpRoi}|legs=${opts.ourPositions.length || legs.length}`,
    },
  });
  await prisma.brokerAccount.update({
    where: { id: accountId },
    data: {
      tpCount: { increment: 1 },
      cycleCount: { increment: 1 },
    },
  });

  if (!repeatEnabled || !allowReentry) {
    if (!repeatEnabled) {
      await disableSymbolBotSide(accountId, symbol, direction);
    }
    return { closed: true as const, reentered: false as const };
  }

  // 틱 도중 사용자가 전체/종목을 끈 경우 재진입 금지
  if (!(await canOpenNewRisk(accountId, symbol, direction))) {
    return { closed: true as const, reentered: false as const, note: "reentry_blocked_toggle" };
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

/** 표 기반 DCA (마틴게일 / 313차) + MT5 스프레드 */
async function runSymbolTableDca(
  accountId: string,
  metaId: string,
  cfg: BotCfg,
  baskets: BasketRow[],
  positions: PosRow[],
) {
  const symbol = cfg.symbol;
  const direction = (cfg.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
  const logic = isTableLogic(cfg.logic) ? normalizeLogicId(cfg.logic) : "dubai_bruno_313";
  const resolved = await resolveStrategyForAccount(accountId, logic, {
    entryMultiplier: cfg.entryMultiplier,
    startLots: cfg.startLots,
  });
  const levels = resolved.levels;
  const startLots = resolved.startLots || cfg.startLots;
  // 회차 상한: entryCount 설정을 존중 (표 전체보다 작으면 캡). 소형 계좌 폭주 방지.
  const maxLevels = Math.max(
    1,
    Math.min(levels.length, cfg.entryCount > 0 ? cfg.entryCount : levels.length),
  );
  const tag = logic.replace(/[^a-z0-9_]/gi, "").slice(0, 12) || "table";

  const levelLots = (levelIndex: number) => {
    // L0(첫 배팅)은 종목별 SymbolBot.startLots를 사용한다. 전략 오버라이드는
    // logicId 단위라 종목별로 다른 첫 배팅을 표현할 수 없으므로, 첫 회차만
    // 종목별 값으로 덮고 이후 물타기 회차는 표/오버라이드 로트를 따른다.
    if (levelIndex === 0 && cfg.startLots > 0) {
      return Math.max(0.01, Math.round(cfg.startLots * 100) / 100);
    }
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
  // 양방향 운용: 같은 종목에 BUY/SELL 바스켓이 공존할 수 있으므로 방향으로 구분한다.
  let basket = baskets.find(
    (b) => symbolsMatch(b.symbol, symbol) && (b.direction === "SELL" ? "SELL" : "BUY") === direction,
  );
  const ourPositions = positionsForSymbol(positions, symbol, direction);

  // Ghost basket (DB open, MT5 empty): heal at account level only — never stop here.
  if (basket && basket.legs.length > 0 && ourPositions.length === 0) {
    return {
      ok: true as const,
      action: "ghost_pending",
      symbol,
      note: "await_ghost_heal",
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

  if (basket?.tradingPaused) {
    // 레거시 pause: 신규·물타기만 막고 익절·손절은 반드시 계속
    cfg = { ...cfg, manageOnly: true };
  }

  if (!basket || basket.legs.length === 0) {
    if (ourPositions.length > 0) return { ok: true as const, note: "external", symbol };
    // 종목/전체 OFF: 신규 진입 금지 (열린 바스켓만 TP/SL 관리)
    if (cfg.manageOnly) {
      return { ok: true as const, note: "manage_only_no_entry", symbol };
    }
    if (!(await canOpenNewRisk(accountId, symbol, direction))) {
      return { ok: true as const, note: "toggle_off_no_entry", symbol };
    }
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

  // 익절 ROI: 313차(bulk 표)는 현재 filledLevel 의 표 profit% (회차 티어).
  // 마틴9 계열은 resolveLiveTakeProfitPct → 고정 20%.
  const levelProfit = levels[basket.filledLevel]?.profit;
  const tpRoiFallback = isBulkLogic(logic)
    ? levelProfit != null && levelProfit > 0
      ? levelProfit
      : resolveLiveTakeProfitPct(logic, cfg.takeProfitPct)
    : resolveLiveTakeProfitPct(
        logic,
        cfg.takeProfitPct > 0
          ? cfg.takeProfitPct
          : resolved.takeProfitPct && resolved.takeProfitPct > 0
            ? resolved.takeProfitPct
            : levelProfit ?? 20,
      );
  const slRoiFallback = resolveLiveStopLossPct(
    logic,
    cfg.stopLossPct > 0
      ? cfg.stopLossPct
      : resolved.stopLossPct && resolved.stopLossPct > 0
        ? resolved.stopLossPct
        : DCA1000_DEFAULT_SL_ROI,
  );
  const brokerLev = Math.max(
    1,
    cfg.brokerLeverage || MT5_BROKER_LEVERAGE_DEFAULT,
  );
  const lotsForTp = posVol > 0 ? posVol : legs.reduce((s, l) => s + l.lots, 0);
  const midRef = avg > 0 ? avg : (price.bid + price.ask) / 2;
  // 브로커 포지션 margin 합 우선 → 없으면 Lot×Contract×Price÷Leverage
  const brokerMarginSum = ourPositions.reduce(
    (s, p) => s + (typeof p.margin === "number" && p.margin > 0 ? p.margin : 0),
    0,
  );
  // 회차 스케일: 바스켓 마진 ROI 기준 라이브 익절$/손절$ (바이낸스식)
  const liveUsd = liveBasketTpSlUsd({
    symbol,
    lots: lotsForTp,
    avgPrice: midRef,
    takeProfitPct: tpRoiFallback,
    stopLossPct: slRoiFallback,
    brokerLeverage: brokerLev,
    brokerMarginSum: brokerMarginSum > 0 ? brokerMarginSum : null,
  });
  const usedMargin = liveUsd.marginUsd;
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
    takeProfitUsd: liveUsd.takeProfitUsd,
    usedMargin,
    tpRoiPct: liveUsd.takeProfitPct,
  });
  // 익절 우선: BasketROI ≥ TP% → 바스켓 전량 청산 → 재진입
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
      // 기록용: MetaAPI 포지션 수익(수수료·스왑 포함). 익절 판정은 위에서 tpPnl.pnl 사용.
      pnlSum: tpPnl.apiProfit,
      floatingRoi: tpDecision.floatingRoi,
      allowReentry: !cfg.manageOnly,
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
      floatingPnl: tpPnl.apiProfit,
      floatingRoi: tpDecision.floatingRoi,
      apiProfit: tpPnl.apiProfit,
      quotePnl: tpPnl.quotePnl,
      spreadCost: tpPnl.spreadCost,
      profit,
      reentered: tpClose.reentered,
      reentryError: tpClose.error,
      spreadPct: spr,
    };
  }

  // 손절: BasketROI ≤ -SL% (마진 ROI, 바이낸스식) → 바스켓 전량 청산
  const slDecision = shouldTriggerStopLossUsd({
    pnl: tpPnl.pnl,
    stopLossUsd: cfg.stopLossEnabled ? liveUsd.stopLossUsd : 0,
    usedMargin: cfg.stopLossEnabled ? usedMargin : 0,
    stopLossRoiPct: cfg.stopLossEnabled ? liveUsd.stopLossPct : 0,
  });
  if (slDecision.hit) {
    const slClose = await closePositionsBySymbolDirection(metaId, symbol, direction);
    if (!slClose.ok || (slClose.remaining ?? 0) > 0) {
      return {
        ok: false as const,
        error:
          ("message" in slClose && slClose.message) ||
          `${symbol} 손절 청산 실패(잔여 ${"remaining" in slClose ? slClose.remaining : "?"})`,
        symbol,
        action: "sl_retry",
      };
    }
    const pnlSum = tpPnl.apiProfit;
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
        note: `${logic}|roi=${floatingRoi.toFixed(2)}%<=-${liveUsd.stopLossPct}%|pnl=${pnlSum.toFixed(2)}<=-sl$${slDecision.stopLossUsd}`,
      },
    });
    await prisma.brokerAccount.update({
      where: { id: accountId },
      data: { slCount: { increment: 1 } },
    });
    if (cfg.stopOnSl) {
      await disableSymbolBotSide(accountId, symbol, direction);
    }
    return {
      ok: true as const,
      action: "sl",
      symbol,
      profit,
      floatingPnl: pnlSum,
      floatingRoi,
      stopLossUsd: slDecision.stopLossUsd,
      spreadPct: spr,
    };
  }

  // 물타기: 순수 바스켓 마진 ROI ≤ -표 drop% (가격 로직 없음). drop 은 20/40/…/350.
  // 한 틱(평가)당 최대 1회차만 추가 → 다음 틱에서 avg/margin/ROI 재계산 (바이낸스 안전주문식).
  // manageOnly / 토글 OFF 시 물타기 금지 (열린 바스켓은 익절·손절만).
  if (cfg.manageOnly) {
    await prisma.basket.update({
      where: { id: basket.id },
      data: { unrealizedPnl: ourPositions.reduce((s, p) => s + p.profit, 0) },
    });
    return {
      ok: true as const,
      action: "manage_hold",
      symbol,
      profit,
      floatingRoi,
      tpMoney: liveUsd.takeProfitUsd,
      stopLossUsd: liveUsd.stopLossUsd,
      spreadPct: spr,
    };
  }

  let filled = basket.filledLevel;
  let actions = 0;
  const maxPerTick = 1;
  let lastDca: ReturnType<typeof shouldTriggerDcaRoi> | null = null;
  while (filled + 1 < maxLevels && actions < maxPerTick) {
    const next = filled + 1;
    const dropRoi = Math.max(0, levels[next]?.drop ?? 0);
    const dcaHit = shouldTriggerDcaRoi({
      pnl: tpPnl.pnl,
      usedMargin,
      dropRoiPct: dropRoi,
    });
    lastDca = dcaHit;
    if (!dcaHit.hit) break;

    if (!(await canOpenNewRisk(accountId, symbol, direction))) {
      break;
    }

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
        note: `${logic}|dcaROI=${dcaHit.basketRoi.toFixed(2)}%<=-${dropRoi}%|margin$${usedMargin.toFixed(2)}`,
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
      basketRoi: lastDca?.basketRoi ?? floatingRoi,
      spreadPct: spr,
    };
  }

  const nextDropRoi =
    filled + 1 < maxLevels ? Math.max(0, levels[filled + 1]?.drop ?? 0) : null;

  await prisma.basket.update({
    where: { id: basket.id },
    data: { unrealizedPnl: tpPnl.pnl },
  });
  return {
    ok: true as const,
    action: "hold",
    symbol,
    profit,
    floatingPnl: tpPnl.pnl,
    floatingRoi,
    apiProfit: tpPnl.apiProfit,
    quotePnl: tpPnl.quotePnl,
    spreadCost: tpPnl.spreadCost,
    tpMoney: liveUsd.takeProfitUsd,
    stopLossUsd: liveUsd.stopLossUsd,
    tpRoi: liveUsd.takeProfitPct,
    basketRoi: floatingRoi,
    nextDropRoi,
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
  const logic = normalizeLogicId(cfg.logic || "dubai_bruno_313");
  if (isTableLogic(logic)) {
    return runSymbolTableDca(accountId, metaId, { ...cfg, logic }, baskets, positions);
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

  let basket = baskets.find(
    (b) => symbolsMatch(b.symbol, symbol) && (b.direction === "SELL" ? "SELL" : "BUY") === direction,
  );
  const ourPositions = positionsForSymbol(positions, symbol, direction);

  // Same as table-logic path: never stop master bot from a single empty snapshot.
  if (basket && basket.legs.length > 0 && ourPositions.length === 0) {
    return {
      ok: true as const,
      action: "ghost_pending",
      symbol,
      note: "await_ghost_heal",
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

  if (basket?.tradingPaused) {
    // 레거시 pause: 신규·물타기만 막고 익절·손절은 반드시 계속
    cfg = { ...cfg, manageOnly: true };
  }

  if (!basket || basket.legs.length === 0) {
    if (ourPositions.length > 0) return { ok: true as const, note: "external", symbol };
    if (cfg.manageOnly) {
      return { ok: true as const, note: "manage_only_no_entry", symbol };
    }
    if (!(await canOpenNewRisk(accountId, symbol, direction))) {
      return { ok: true as const, note: "toggle_off_no_entry", symbol };
    }
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
  const nextLevel = basket.filledLevel + 1;
  const brokerLev = Math.max(1, cfg.brokerLeverage || MT5_BROKER_LEVERAGE_DEFAULT);
  const lotsForTp = posVol > 0 ? posVol : legs.reduce((s, l) => s + l.lots, 0);
  const midRef = avg > 0 ? avg : (price.bid + price.ask) / 2;
  const brokerMarginSum = ourPositions.reduce(
    (s, p) => s + (typeof p.margin === "number" && p.margin > 0 ? p.margin : 0),
    0,
  );
  const liveUsd = liveBasketTpSlUsd({
    symbol,
    lots: lotsForTp,
    avgPrice: midRef,
    takeProfitPct: resolveLiveTakeProfitPct(logic, cfg.takeProfitPct),
    stopLossPct: resolveLiveStopLossPct(logic, cfg.stopLossPct),
    brokerLeverage: brokerLev,
    brokerMarginSum: brokerMarginSum > 0 ? brokerMarginSum : null,
  });
  const usedMargin = liveUsd.marginUsd;
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
    takeProfitUsd: liveUsd.takeProfitUsd,
    usedMargin,
    tpRoiPct: liveUsd.takeProfitPct,
  });

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
      pnlSum: tpPnl.apiProfit,
      floatingRoi: tpDecision.floatingRoi,
      allowReentry: !cfg.manageOnly,
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
      floatingPnl: tpPnl.apiProfit,
      floatingRoi,
    };
  }

  const slDecision = shouldTriggerStopLossUsd({
    pnl: tpPnl.pnl,
    stopLossUsd: cfg.stopLossEnabled ? liveUsd.stopLossUsd : 0,
    usedMargin: cfg.stopLossEnabled ? usedMargin : 0,
    stopLossRoiPct: cfg.stopLossEnabled ? liveUsd.stopLossPct : 0,
  });
  if (slDecision.hit) {
    const slClose = await closePositionsBySymbolDirection(metaId, symbol, direction);
    if (!slClose.ok || (slClose.remaining ?? 0) > 0) {
      return {
        ok: false as const,
        error:
          ("message" in slClose && slClose.message) ||
          `${symbol} 손절 청산 실패(잔여 ${"remaining" in slClose ? slClose.remaining : "?"})`,
        symbol,
        action: "sl_retry",
      };
    }
    await prisma.basket.update({
      where: { id: basket.id },
      data: {
        status: "closed",
        realizedPnl: tpPnl.apiProfit,
        lastExitAt: new Date(),
        unrealizedPnl: 0,
      },
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
        pnl: tpPnl.apiProfit,
        kind: "SL",
        note: `${logic}|roi=${floatingRoi.toFixed(2)}%<=-${liveUsd.stopLossPct}%|pnl=${tpPnl.apiProfit.toFixed(2)}<=-sl$${slDecision.stopLossUsd}`,
      },
    });
    if (cfg.stopOnSl) {
      await disableSymbolBotSide(accountId, symbol, direction);
    }
    return {
      ok: true as const,
      action: "sl",
      symbol,
      stopLossUsd: slDecision.stopLossUsd,
      floatingPnl: tpPnl.apiProfit,
      floatingRoi,
    };
  }

  if (cfg.manageOnly) {
    await prisma.basket.update({
      where: { id: basket.id },
      data: { unrealizedPnl: ourPositions.reduce((s, p) => s + p.profit, 0) },
    });
    return {
      ok: true as const,
      action: "manage_hold",
      symbol,
      profit,
      floatingRoi,
      tpMoney: liveUsd.takeProfitUsd,
      stopLossUsd: liveUsd.stopLossUsd,
    };
  }

  if (nextLevel < maxLevels) {
    // 순수 바스켓 마진 ROI ≤ -needRoi% (가격 로직 없음)
    const lots = lotsAtLevel(cfg.startLots, cfg.entryMultiplier, nextLevel, logic);
    const needRoi = (cfg.entryIntervalPct || 5) * nextLevel;
    const dcaHit = shouldTriggerDcaRoi({
      pnl: tpPnl.pnl,
      usedMargin,
      dropRoiPct: needRoi,
    });
    if (dcaHit.hit) {
      if (!(await canOpenNewRisk(accountId, symbol, direction))) {
        await prisma.basket.update({
          where: { id: basket.id },
          data: { unrealizedPnl: ourPositions.reduce((s, p) => s + p.profit, 0) },
        });
        return {
          ok: true as const,
          action: "hold",
          symbol,
          note: "toggle_off_no_dca",
          profit,
          floatingRoi,
          tpMoney: liveUsd.takeProfitUsd,
          stopLossUsd: liveUsd.stopLossUsd,
        };
      }
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
          note: `${logic}|dcaROI=${dcaHit.basketRoi.toFixed(2)}%<=-${needRoi}%|margin$${usedMargin.toFixed(2)}`,
        },
      });
      return { ok: true as const, action: "dca", level: nextLevel, symbol };
    }
  }

  await prisma.basket.update({
    where: { id: basket.id },
    data: { unrealizedPnl: ourPositions.reduce((s, p) => s + p.profit, 0) },
  });
  return {
    ok: true as const,
    action: "hold",
    symbol,
    profit,
    floatingRoi,
    tpMoney: liveUsd.takeProfitUsd,
    stopLossUsd: liveUsd.stopLossUsd,
  };
}

const tickLocks = new Set<string>();
const lastEquitySnapAt = new Map<string, number>();

const TICK_LOCK_STALE_MS = Math.max(
  20_000,
  Number(process.env.ENGINE_TICK_LOCK_STALE_MS || 45_000),
);

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
      // enabled=false 종목도 열린 바스켓이 있으면 TP/SL 관리 필요
      symbolBots: true,
      baskets: { where: { status: "open" }, include: { legs: true } },
    },
  });
  if (!account?.metaApiAccountId) {
    return { skipped: true as const };
  }

  const masterOn = !!account.botEnabled;
  const hasOpenBaskets = account.baskets.length > 0;
  // 전체 OFF + 열린 포지션 없음 → 틱 스킵
  if (!masterOn && !hasOpenBaskets) {
    return { skipped: true as const, reason: "bot_off" };
  }
  // Bot ON + cloud cold: recover here too (not only in runAllBots).
  // Previously status==="undeployed" skipped the whole tick → trading looked "stopped".
  if (account.status !== "connected" && account.status !== "undeployed") {
    return { skipped: true as const, reason: "not_connected" };
  }

  const metaId = account.metaApiAccountId;
  let snap = await fetchSnapshot(metaId);
  let cloudJustRecovered = false;
  // Bot ON but MetaAPI cloud cold/undeployed → redeploy once (never leave live money unmonitored)
  if (
    (!snap.ok && isCloudColdError(snap.message || "")) ||
    account.status === "undeployed"
  ) {
    const waitMs = Math.max(
      8_000,
      Number(process.env.ENGINE_CLOUD_WAIT_MS || 45_000),
    );
    let recovered = false;
    if (account.syncToken) {
      const live = await ensureAccountCloudLive({
        metaApiAccountId: metaId,
        login: account.login,
        password: account.syncToken,
        server: account.server,
        waitMs,
      });
      if (live.ok) {
        snap = live.snap;
        recovered = true;
        if (live.metaApiAccountId !== metaId) {
          await prisma.brokerAccount.update({
            where: { id: account.id },
            data: { metaApiAccountId: live.metaApiAccountId },
          });
        }
      }
    } else {
      const live = await ensureCloudLive(metaId, waitMs);
      if (live.ok && live.snap) {
        snap = live.snap;
        recovered = true;
      }
    }
    if (recovered) {
      cloudJustRecovered = true;
      await prisma.brokerAccount.update({
        where: { id: account.id },
        data: {
          status: "connected",
          ...(masterOn
            ? {
                botStoppedAt: null,
                statusMessage: "클라우드 재활성화 · 봇 실행 중",
              }
            : {
                statusMessage: "클라우드 재활성화 · 열린 포지션 익절·손절 관리 중",
              }),
        },
      });
    }
  }
  if (!snap.ok) {
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        statusMessage: snap.message,
        // Keep botEnabled; only mark cloud cold — next tick will redeploy.
        ...(isCloudColdError(snap.message || "")
          ? { status: "undeployed" }
          : {}),
      },
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
      statusMessage: masterOn
        ? "클라우드 연결 · 봇 실행 중"
        : "봇 중지 · 열린 포지션 익절·손절만 관리",
    },
  });

  // Ghost baskets: DB만 정리. 봇 전체 중지는 절대 하지 않음.
  const healedGhost = await healGhostBaskets(
    account.id,
    metaId,
    account.baskets,
    snap.positions,
    {
      skip: cloudJustRecovered,
      margin: snap.margin,
      equity: snap.equity,
      balance: snap.balance,
    },
  );

  let openBaskets = account.baskets;
  if (healedGhost) {
    openBaskets = await prisma.basket.findMany({
      where: { accountId: account.id, status: "open" },
      include: { legs: true },
    });
  }

  const lastEq = lastEquitySnapAt.get(account.id) || 0;
  if (Date.now() - lastEq > 60_000) {
    lastEquitySnapAt.set(account.id, Date.now());
    await prisma.equitySnapshot.create({
      data: { accountId: account.id, equity: snap.equity, balance: snap.balance },
    });
  }

  const lev = snap.leverage > 0 ? snap.leverage : MT5_BROKER_LEVERAGE_DEFAULT;
  const mapBotRow = (
    b: (typeof account.symbolBots)[number],
    manageOnly: boolean,
    directionOverride?: string,
  ): BotCfg => ({
    symbol: b.symbol,
    logic: normalizeLogicId(b.logic),
    direction: directionOverride ?? b.direction,
    dualDirection: (b as { dualDirection?: boolean }).dualDirection ?? false,
    entryCount: b.entryCount,
    entryMultiplier: b.entryMultiplier,
    entryIntervalPct: b.entryIntervalPct,
    takeProfitPct: resolveLiveTakeProfitPct(b.logic, b.takeProfitPct),
    takeProfitUsd: b.takeProfitUsd ?? 0,
    startLots: b.startLots,
    repeatEnabled: b.repeatEnabled,
    stopLossPct: resolveLiveStopLossPct(b.logic, b.stopLossPct),
    stopLossUsd: b.stopLossUsd ?? 0,
    stopLossEnabled: b.stopLossEnabled,
    stopOnSl: b.stopOnSl,
    brokerLeverage: lev,
    manageOnly,
  });

  const botByKey = new Map(
    account.symbolBots.map((b) => [`${b.symbol}|${b.direction === "SELL" ? "SELL" : "BUY"}`, b]),
  );

  // 활성 봇 + 열린 바스켓(꺼진 종목 포함) 전부 틱 대상
  const needed = new Map<string, { manageOnly: boolean }>();
  for (const b of account.symbolBots) {
    if (!b.enabled) continue;
    const dir = b.direction === "SELL" ? "SELL" : "BUY";
    if (b.dualDirection) {
      needed.set(`${b.symbol}|BUY`, { manageOnly: !masterOn });
      needed.set(`${b.symbol}|SELL`, { manageOnly: !masterOn });
    } else {
      needed.set(`${b.symbol}|${dir}`, { manageOnly: !masterOn });
    }
  }
  for (const basket of openBaskets) {
    const dir = basket.direction === "SELL" ? "SELL" : "BUY";
    const key = `${basket.symbol}|${dir}`;
    const row = botByKey.get(key);
    const manageOnly = !masterOn || !row?.enabled;
    const prev = needed.get(key);
    if (!prev) {
      needed.set(key, { manageOnly });
    } else if (manageOnly) {
      // 열린 바스켓이 있으면 OFF여도 manageOnly 유지
      needed.set(key, { manageOnly: true });
    }
  }

  // MT5에만 남은 포지션(DB 바스켓 없음)도 익절·손절 관리 대상에 포함
  for (const p of snap.positions) {
    const dir = (p.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
    let matchedKey: string | null = null;
    for (const key of needed.keys()) {
      const [sym, d] = key.split("|");
      if (d === dir && symbolsMatch(sym, p.symbol)) {
        matchedKey = key;
        break;
      }
    }
    if (matchedKey) continue;
    const row = account.symbolBots.find(
      (b) =>
        symbolsMatch(b.symbol, p.symbol) &&
        (b.dualDirection || (b.direction === "SELL" ? "SELL" : "BUY") === dir),
    );
    const key = `${row?.symbol || p.symbol}|${dir}`;
    needed.set(key, { manageOnly: true });
  }

  let bots: BotCfg[] = [];
  for (const [key, { manageOnly }] of needed) {
    const [symbol, direction] = key.split("|") as [string, string];
    let row = botByKey.get(key);
    if (!row) {
      // dualDirection 단일 행이 BUY|SELL 둘 다 커버하는 경우
      row = account.symbolBots.find(
        (b) =>
          b.symbol === symbol &&
          ((b as { dualDirection?: boolean }).dualDirection ||
            (b.direction === "SELL" ? "SELL" : "BUY") === direction),
      );
    }
    if (row) {
      bots.push({ ...mapBotRow(row, manageOnly, direction), dualDirection: false });
      continue;
    }
    // 바스켓만 있고 SymbolBot 행이 없으면 기본 설정으로 관리만
    const c = account.config;
    const orphanLogic = "dubai_bruno_313";
    bots.push({
      symbol,
      logic: orphanLogic,
      direction,
      entryCount: c?.entryCount ?? 314,
      entryMultiplier: c?.entryMultiplier ?? 1,
      entryIntervalPct: c?.entryIntervalPct ?? 5,
      takeProfitPct: resolveLiveTakeProfitPct(orphanLogic, c?.takeProfitPct ?? 20),
      takeProfitUsd: 0,
      startLots: c?.startLots || c?.baseLots || 0.01,
      repeatEnabled: false,
      stopLossPct: resolveLiveStopLossPct(orphanLogic, c?.stopLossPct),
      stopLossUsd: 0,
      stopLossEnabled: c?.stopLossEnabled ?? true,
      stopOnSl: c?.stopOnSl ?? true,
      brokerLeverage: lev,
      manageOnly: true,
    });
  }

  // 레거시: SymbolBot 없고 config만 있을 때 (마스터 ON)
  if (bots.length === 0 && account.config && masterOn) {
    const c = account.config;
    const legacyLogic = "dubai_bruno_313";
    bots = [
      {
        symbol: c.symbol || "EURUSD",
        logic: legacyLogic,
        direction: c.direction || "BUY",
        entryCount: c.entryCount,
        entryMultiplier: c.entryMultiplier,
        entryIntervalPct: c.entryIntervalPct,
        takeProfitPct: resolveLiveTakeProfitPct(legacyLogic, c.takeProfitPct),
        takeProfitUsd: 0,
        startLots: c.startLots || c.baseLots,
        repeatEnabled: c.repeatEnabled,
        stopLossPct: resolveLiveStopLossPct(legacyLogic, c.stopLossPct),
        stopLossUsd: 0,
        stopLossEnabled: c.stopLossEnabled,
        stopOnSl: c.stopOnSl,
        brokerLeverage: lev,
        manageOnly: false,
      },
    ];
  }

  if (bots.length === 0) {
    return { ok: true as const, results: [], note: "no_bots" };
  }

  // 심볼명 사전 해석 (XAU→GOLD 등) — 진입 전 캐시 워밍
  await Promise.all(bots.map((b) => resolveBrokerSymbol(metaId, b.symbol)));

  // dualDirection은 위에서 BUY/SELL로 이미 펼쳤음
  const runs = bots;

  // 동일 계좌 증거금 레이스 방지: 순차 처리 (TP→SL→DCA 순서는 심볼 내부)
  const results = [];
  let liveBaskets = openBaskets;
  let livePositions = snap.positions;
  for (const bot of runs) {
    try {
      const r = await runSymbolDca(account.id, metaId, bot, liveBaskets, livePositions);
      results.push(r);
      const action =
        r && typeof r === "object" && "action" in r
          ? String((r as { action?: string }).action || "")
          : "";
      // 주문/청산 후 스냅·바스켓 갱신 → 다음 종목 꼬임 방지
      if (action === "tp" || action === "sl" || action === "entry" || action === "dca") {
        const fresh = await fetchSnapshot(metaId);
        if (fresh.ok) {
          livePositions = fresh.positions;
          snap = fresh;
        }
        liveBaskets = await prisma.basket.findMany({
          where: { accountId: account.id, status: "open" },
          include: { legs: true },
        });
      }
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
        statusMessage: `${masterOn ? "봇 실행 중" : "포지션 관리 중"} · 일부 종목 오류: ${failNotes[0]}`.slice(
          0,
          180,
        ),
      },
    });
  }

  // 오늘 실현 = MT5 딜 히스토리 (실패해도 매매 틱은 계속)
  try {
    await syncTodayPnlFromMt5Deals({
      accountId: account.id,
      metaApiAccountId: metaId,
      equity: snap.equity,
      startingBalance: account.startingBalance,
    });
  } catch (e) {
    console.warn(
      `[engine] pnl sync skip account=${account.id}`,
      e instanceof Error ? e.message : e,
    );
  }

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
 * Rejected owners are skipped so ban gate applies to trading too.
 */
function resolveTickBudgetMs(optsBudget?: number): number {
  if (optsBudget != null && Number.isFinite(optsBudget)) return optsBudget;
  const fromEnv = Number(process.env.ENGINE_BUDGET_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  // Local direct engine: do not starve accounts (serverless cron keeps 52s)
  if (process.env.ENGINE_MODE === "direct") return 600_000;
  return 52_000;
}

export async function runAllBots(opts: RunAllBotsOpts = {}) {
  const { undeployIdleAccounts } = await import("./cost-optimize");
  const budgetMs = resolveTickBudgetMs(opts.budgetMs);
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
      metaApiAccountId: { not: null },
      status: { in: ["connected", "undeployed"] },
      user: {
        OR: [{ role: "admin" }, { approvalStatus: "approved" }],
      },
      // 전체 OFF여도 열린 바스켓이 있으면 익절·손절 관리 틱 필요
      OR: [
        { botEnabled: true },
        { baskets: { some: { status: "open" } } },
      ],
    },
    // Round-robin fairness: oldest tick lock / oldest update first
    orderBy: [{ tickLockedAt: "asc" }, { updatedAt: "asc" }],
    select: {
      id: true,
      status: true,
      metaApiAccountId: true,
      login: true,
      server: true,
      syncToken: true,
    },
  });

  // DB 바스켓이 없어도 equity≠balance(부동손익)면 관리 틱에 포함
  const seen = new Set(accounts.map((a) => a.id));
  const maybeFloating = await prisma.brokerAccount.findMany({
    where: {
      botEnabled: false,
      metaApiAccountId: { not: null },
      status: { in: ["connected", "undeployed"] },
      user: {
        OR: [{ role: "admin" }, { approvalStatus: "approved" }],
      },
      id: { notIn: [...seen] },
    },
    select: {
      id: true,
      status: true,
      metaApiAccountId: true,
      login: true,
      server: true,
      syncToken: true,
      equity: true,
      balance: true,
    },
  });
  for (const a of maybeFloating) {
    if (Math.abs(a.equity - a.balance) > 1) {
      accounts.push({
        id: a.id,
        status: a.status,
        metaApiAccountId: a.metaApiAccountId,
        login: a.login,
        server: a.server,
        syncToken: a.syncToken,
      });
    }
  }
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
        // Local engine can wait longer; serverless cron must stay under ~52s
        const maxWait =
          process.env.ENGINE_MODE === "direct"
            ? Math.min(70_000, Number(process.env.ENGINE_CLOUD_WAIT_MS || 60_000))
            : 12_000;
        const remaining = Math.max(3_000, Math.min(maxWait, budgetMs - elapsed - 2_000));
        let liveOk = false;
        if (a.syncToken) {
          const live = await ensureAccountCloudLive({
            metaApiAccountId: String(a.metaApiAccountId),
            login: a.login,
            password: a.syncToken,
            server: a.server,
            waitMs: remaining,
          });
          if (live.ok) {
            liveOk = true;
            if (live.metaApiAccountId !== a.metaApiAccountId) {
              await prisma.brokerAccount.update({
                where: { id: a.id },
                data: { metaApiAccountId: live.metaApiAccountId },
              });
            }
          } else {
            results.push({
              id: a.id,
              ok: false,
              error: live.message || "redeploy failed",
            });
            continue;
          }
        } else {
          const live = await ensureCloudLive(String(a.metaApiAccountId), remaining);
          if (!live.ok) {
            results.push({
              id: a.id,
              ok: false,
              error: live.message || "redeploy failed",
            });
            continue;
          }
          liveOk = true;
        }
        if (liveOk) {
          await prisma.brokerAccount.update({
            where: { id: a.id },
            data: {
              status: "connected",
              botStoppedAt: null,
              statusMessage: "클라우드 재활성화 · 봇 실행 중",
            },
          });
        }
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
