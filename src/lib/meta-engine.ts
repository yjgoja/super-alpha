import {
  liveBasketTpSlUsd,
  mt5EntryQuote,
  mt5FloatingRoiPct,
  mt5PnlForTakeProfit,
  mt5ProfitPct,
  mt5UsedMargin,
  shouldTriggerDcaRoi,
  shouldTriggerStopLossUsd,
  shouldTriggerTakeProfit,
  spreadPct,
  basketExitPricesFromUsd,
  brokerProtectionMatches,
  clampBasketProtectForLegs,
  MT5_BROKER_LEVERAGE_DEFAULT,
  DCA1000_DEFAULT_SL_ROI,
} from "./dca1000";
import {
  isBulkLogic,
  isMartin9TimeLogic,
  isSustainedBulkLogic,
  isTableLogic,
  lotsForLogicLevel,
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
  tableLogicMeta,
} from "./table-logics";
import { normalizeLogicId } from "./strategies";
import { resolveStrategyForAccount } from "./strategy-resolve";
import {
  closeAllPositions,
  closePositionsBySymbolDirection,
  ensureAccountCloudLive,
  ensureCloudLive,
  fetchSnapshot,
  getSymbolPrice,
  modifyPositionProtection,
  placeMarketOrder,
  resolveBrokerSymbol,
  symbolsMatch,
  getSymbolTradeSpec,
  fetchHistoryDeals,
  primeMetaRegionCache,
  refreshAccountRegion,
  clearMetaRegionCache,
  metaApiTradeCreditBlocked,
  syncTradeCreditPauseFromDb,
} from "./metaapi";
import { ensureTradingSchema, prisma } from "./db";
import { isCloudColdError } from "./engine-guard";
import {
  loadOpenBurstSettings,
  saveOpenBurstSettings,
} from "./open-burst-settings";
import {
  isFxMarketClosed,
  isFxMarketOpen,
  isInOpenBurstQuietPeriod,
  isMarketSessionBlockedError,
  isSessionTradeBackoffReason,
} from "./market-hours";
import {
  canH8Enter,
  h8DirectionFromOpen,
  h8SessionKey,
  isH8OpenMinute,
  isInH8EntryQuiet,
} from "./session-h8";
import {
  hasEnabledTraderForSide,
  mergeNeededSide,
  resolveEnabledFixedBotForSide,
  resolveSymbolBotForSide,
  shouldDisableOnSideStop,
  type NeededSide,
} from "./bot-resolve";
import { syncTodayPnlFromMt5Deals } from "./mt5-pnl-sync";
import { setAccountLiveState } from "./state-cache";
import {
  assertLevelNotAlreadyOpen,
  getSharedSoftCloseCooldown,
  persistSoftCloseCooldown,
  positionsAreNaked,
} from "./trade-guards";

/** Soft TP market-close backoff — stops trade-API storms when market is closed. */
const softCloseCooldown = new Map<
  string,
  { until: number; reason: string; loggedAt: number }
>();

/** H8 time-logic session state (memory + DB — survives Render restarts). */
type H8SessionState = {
  sessionKey: string;
  barOpen: number | null;
  entered: boolean;
  direction: "BUY" | "SELL" | null;
};
const h8SessionState = new Map<string, H8SessionState>();

function h8StateKey(accountId: string, symbol: string, logic: string) {
  return `${accountId}|${symbol}|${normalizeLogicId(logic)}`;
}

function h8PersistSlot(symbol: string, logic: string) {
  return `${symbol}|${normalizeLogicId(logic)}`;
}

function softCloseKey(accountId: string, symbol: string, direction: string) {
  return `${accountId}|${symbol}|${direction}`;
}

function parseH8State(raw: unknown): H8SessionState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sessionKey = String(o.sessionKey || "");
  if (!sessionKey) return null;
  const dir = o.direction === "BUY" || o.direction === "SELL" ? o.direction : null;
  const barOpen =
    typeof o.barOpen === "number" && Number.isFinite(o.barOpen) && o.barOpen > 0
      ? o.barOpen
      : null;
  return {
    sessionKey,
    barOpen,
    entered: !!o.entered,
    direction: dir,
  };
}

async function loadH8StateFromDb(
  accountId: string,
  symbol: string,
  logic: string,
): Promise<H8SessionState | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ h8SessionState: unknown }>>(
      `SELECT "h8SessionState" FROM "BrokerAccount" WHERE id = $1 LIMIT 1`,
      accountId,
    );
    const map = rows[0]?.h8SessionState;
    if (!map || typeof map !== "object" || Array.isArray(map)) return null;
    return parseH8State((map as Record<string, unknown>)[h8PersistSlot(symbol, logic)]);
  } catch (e) {
    console.warn(
      `[engine] h8 load failed account=${accountId}`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

async function saveH8StateToDb(
  accountId: string,
  symbol: string,
  logic: string,
  state: H8SessionState,
) {
  try {
    const slot = h8PersistSlot(symbol, logic);
    await prisma.$executeRawUnsafe(
      `UPDATE "BrokerAccount"
       SET "h8SessionState" = COALESCE("h8SessionState", '{}'::jsonb) || $1::jsonb
       WHERE id = $2`,
      JSON.stringify({ [slot]: state }),
      accountId,
    );
  } catch (e) {
    console.warn(
      `[engine] h8 save failed account=${accountId}`,
      e instanceof Error ? e.message : e,
    );
  }
}

async function rememberH8State(
  accountId: string,
  symbol: string,
  logic: string,
  state: H8SessionState,
) {
  const sk = h8StateKey(accountId, symbol, logic);
  h8SessionState.set(sk, state);
  await saveH8StateToDb(accountId, symbol, logic, state);
}

async function snapH8BarOpen(metaId: string, symbol: string): Promise<number | null> {
  const price = await getSymbolPrice(metaId, symbol);
  if (price && price.bid > 0 && price.ask > 0) {
    return (price.bid + price.ask) / 2;
  }
  return null;
}

/**
 * H8 time logic: flatten on new bar + snap barOpen.
 * Persisted so Render redeploys do not wipe the session.
 * Cold start during open quiet (0–15m) may still snap barOpen from live mid.
 */
async function syncH8TimeSession(opts: {
  accountId: string;
  metaId: string;
  symbol: string;
  logic: string;
  positions: PosRow[];
  baskets: BasketRow[];
}): Promise<{
  state: H8SessionState;
  closed: boolean;
  positions: PosRow[];
  baskets: BasketRow[];
}> {
  const logic = normalizeLogicId(opts.logic);
  const sk = h8StateKey(opts.accountId, opts.symbol, logic);
  const sessionKey = h8SessionKey();
  let prev = h8SessionState.get(sk);
  if (!prev) {
    const fromDb = await loadH8StateFromDb(opts.accountId, opts.symbol, logic);
    if (fromDb) {
      prev = fromDb;
      h8SessionState.set(sk, fromDb);
    }
  }
  let positions = opts.positions;
  let baskets = opts.baskets;
  let closed = false;

  const ourPos = positions.filter((p) => symbolsMatch(p.symbol, opts.symbol));
  const ourBaskets = baskets.filter(
    (b) => symbolsMatch(b.symbol, opts.symbol) && b.legs.length > 0,
  );
  const hasOpen = ourPos.length > 0 || ourBaskets.length > 0;

  const closeBothSides = async () => {
    for (const dir of ["BUY", "SELL"] as const) {
      const sidePos = ourPos.filter((p) => p.direction === dir);
      const sideBaskets = ourBaskets.filter(
        (b) => (b.direction === "SELL" ? "SELL" : "BUY") === dir,
      );
      if (sidePos.length === 0 && sideBaskets.length === 0) {
        continue;
      }
      const closeRes = await closeSideFailClosed({
        metaId: opts.metaId,
        symbol: opts.symbol,
        direction: dir,
        expectedPositions: sidePos.length,
      });
      if (!closeRes.ok) {
        console.error(
          `[engine] h8 flatten FAIL account=${opts.accountId} ${opts.symbol} ${dir}: ${closeRes.message} — leave baskets open`,
        );
        continue;
      }
      for (const b of sideBaskets) {
        await prisma.basket.update({
          where: { id: b.id },
          data: {
            status: "closed",
            lastExitAt: new Date(),
            unrealizedPnl: 0,
          },
        });
        await prisma.fill.create({
          data: {
            accountId: opts.accountId,
            symbol: opts.symbol,
            side: dir === "BUY" ? "SELL" : "BUY",
            lots: b.legs.reduce((s, l) => s + l.lots, 0),
            price: 0,
            kind: "SESSION",
            note: `${logic}|h8_flatten|${sessionKey}`,
          },
        });
      }
    }
    closed = true;
    const fresh = await fetchSnapshot(opts.metaId);
    if (fresh.ok) positions = fresh.positions;
    baskets = await prisma.basket.findMany({
      where: { accountId: opts.accountId, status: "open" },
      include: { legs: true },
    });
  };

  if (!prev) {
    if (hasOpen) {
      const dir = (ourPos[0]?.direction ||
        (ourBaskets[0]?.direction === "SELL" ? "SELL" : "BUY")) as "BUY" | "SELL";
      const state: H8SessionState = {
        sessionKey,
        barOpen: null,
        entered: true,
        direction: dir,
      };
      await rememberH8State(opts.accountId, opts.symbol, logic, state);
      return { state, closed: false, positions, baskets };
    }
    if (isH8OpenMinute() || isInH8EntryQuiet() || canH8Enter()) {
      const mid = await snapH8BarOpen(opts.metaId, opts.symbol);
      const degraded = canH8Enter() && !isInH8EntryQuiet() && !isH8OpenMinute();
      if (degraded) {
        console.warn(
          `[engine] h8 degraded barOpen=live mid (missed open) account=${opts.accountId} ${opts.symbol} ${logic} session=${sessionKey}`,
        );
      }
      const state: H8SessionState = {
        sessionKey,
        barOpen: mid,
        entered: false,
        direction: null,
      };
      await rememberH8State(opts.accountId, opts.symbol, logic, state);
      return { state, closed: false, positions, baskets };
    }
    const state: H8SessionState = {
      sessionKey,
      barOpen: null,
      entered: true,
      direction: null,
    };
    await rememberH8State(opts.accountId, opts.symbol, logic, state);
    console.warn(
      `[engine] h8 fail-closed mid-session account=${opts.accountId} ${opts.symbol} ${logic} session=${sessionKey}`,
    );
    return { state, closed: false, positions, baskets };
  }

  if (prev.sessionKey !== sessionKey) {
    if (hasOpen) await closeBothSides();
    if (isH8OpenMinute() || isInH8EntryQuiet() || canH8Enter()) {
      const mid = await snapH8BarOpen(opts.metaId, opts.symbol);
      const state: H8SessionState = {
        sessionKey,
        barOpen: mid,
        entered: false,
        direction: null,
      };
      await rememberH8State(opts.accountId, opts.symbol, logic, state);
      return { state, closed, positions, baskets };
    }
    const state: H8SessionState = {
      sessionKey,
      barOpen: null,
      entered: true,
      direction: null,
    };
    await rememberH8State(opts.accountId, opts.symbol, logic, state);
    return { state, closed, positions, baskets };
  }

  if (prev.barOpen == null && !prev.entered && (isH8OpenMinute() || isInH8EntryQuiet())) {
    const mid = await snapH8BarOpen(opts.metaId, opts.symbol);
    if (mid != null) {
      prev = { ...prev, barOpen: mid };
      await rememberH8State(opts.accountId, opts.symbol, logic, prev);
    }
  }

  // Prior deploy left fail-closed (entered + no barOpen) while flat — unlock degraded.
  // Keep a known locked direction when present (restart mid-bar after broker TP).
  if (
    prev.entered &&
    prev.barOpen == null &&
    !hasOpen &&
    canH8Enter()
  ) {
    const mid = await snapH8BarOpen(opts.metaId, opts.symbol);
    if (mid != null) {
      console.warn(
        `[engine] h8 unlock fail-closed → degraded barOpen account=${opts.accountId} ${opts.symbol} ${logic}`,
      );
      prev = {
        sessionKey,
        barOpen: mid,
        entered: false,
        direction:
          prev.direction === "BUY" || prev.direction === "SELL"
            ? prev.direction
            : null,
      };
      await rememberH8State(opts.accountId, opts.symbol, logic, prev);
    }
  }

  return { state: prev, closed: false, positions, baskets };
}

function getSoftCloseCooldown(key: string) {
  const hit = softCloseCooldown.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.until) {
    softCloseCooldown.delete(key);
    return null;
  }
  return hit;
}

function noteSoftCloseBackoff(key: string, reason: string, ms: number) {
  const prev = softCloseCooldown.get(key);
  softCloseCooldown.set(key, {
    until: Date.now() + ms,
    reason,
    loggedAt: prev?.loggedAt ?? 0,
  });
}

async function noteSoftCloseBackoffShared(opts: {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  reason: string;
  ms: number;
}) {
  const key = softCloseKey(opts.accountId, opts.symbol, opts.direction);
  noteSoftCloseBackoff(key, opts.reason, opts.ms);
  await persistSoftCloseCooldown({
    accountId: opts.accountId,
    symbol: opts.symbol,
    direction: opts.direction,
    reason: opts.reason,
    untilMs: opts.ms,
  });
}

async function getSoftCloseCooldownShared(opts: {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
}) {
  const key = softCloseKey(opts.accountId, opts.symbol, opts.direction);
  const mem = getSoftCloseCooldown(key);
  if (mem) return mem;
  const shared = await getSharedSoftCloseCooldown(opts);
  if (shared) {
    softCloseCooldown.set(key, {
      until: shared.until,
      reason: shared.reason,
      loggedAt: 0,
    });
    return shared;
  }
  return null;
}

function markSoftCloseLogged(key: string) {
  const prev = softCloseCooldown.get(key);
  if (!prev) {
    softCloseCooldown.set(key, { until: 0, reason: "", loggedAt: Date.now() });
    return;
  }
  prev.loggedAt = Date.now();
}

/** 브로커 지정가 TP/SL — 기본 ON. BROKER_PROTECT_TP_SL=0 이면 끔 */
function brokerProtectEnabled() {
  const v = (process.env.BROKER_PROTECT_TP_SL || "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

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
  createdAt?: Date | string;
  updatedAt?: Date | string;
  legs: { level: number; lots: number; price: number }[];
};

/** Account float/margin with an empty book → classic MetaAPI lag. */
const GHOST_LAG_MARGIN_USD = 1;
const GHOST_LAG_FLOAT_USD = 1;
/** Ghost with no OUT deal: allow DB reconcile after this age when side stays empty. */
const GHOST_STALE_RECONCILE_MS = 2 * 60 * 60 * 1000;
/** Look back from earliest ghost createdAt (capped). */
const GHOST_DEAL_HIST_MAX_MS = 7 * 24 * 60 * 60 * 1000;

type PosRow = {
  id?: string;
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  price: number;
  profit: number;
  margin?: number;
  stopLoss?: number;
  takeProfit?: number;
};

/**
 * 열린 바스켓 전 레그에 동일 브로커 TP/SL 지정가 동기화.
 * 드리프트(미설정·오차 > 2틱)만 modify. 소프트웨어 ROI 청산과 병행.
 */
async function syncBrokerBasketProtection(opts: {
  metaId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  positions: PosRow[];
  avgPrice: number;
  lots: number;
  takeProfitUsd: number;
  stopLossUsd: number;
  stopLossEnabled: boolean;
}) {
  if (!brokerProtectEnabled()) {
    return { synced: 0, skipped: true as const, drift: false, targets: null, allProtected: true };
  }
  const targetsRaw = basketExitPricesFromUsd({
    symbol: opts.symbol,
    direction: opts.direction,
    avgPrice: opts.avgPrice,
    lots: opts.lots,
    takeProfitUsd: opts.takeProfitUsd,
    stopLossUsd: opts.stopLossEnabled ? opts.stopLossUsd : 0,
  });
  const legs = opts.positions.filter(
    (p) => p.id && symbolsMatch(p.symbol, opts.symbol) && p.direction === opts.direction,
  );
  let stopsLevelPoints = 0;
  let point = targetsRaw.point;
  try {
    const spec = await getSymbolTradeSpec(opts.metaId, opts.symbol);
    stopsLevelPoints = spec.stopsLevel;
    if (spec.point > 0) point = spec.point;
  } catch {
    /* fallback point */
  }
  const clamped = clampBasketProtectForLegs({
    direction: opts.direction,
    openPrices: legs.map((p) => p.price),
    takeProfit: targetsRaw.takeProfit,
    stopLoss: targetsRaw.stopLoss,
    point,
    stopsLevelPoints,
  });
  const targets = {
    ...targetsRaw,
    point,
    takeProfit: clamped.takeProfit,
    stopLoss: clamped.stopLoss,
  };
  if (targets.takeProfit == null && targets.stopLoss == null) {
    console.error(
      `[engine] protect targets null ${opts.symbol} ${opts.direction} — soft guard only`,
    );
    return {
      synced: 0,
      skipped: true as const,
      drift: true,
      failed: legs.length,
      targets,
      allProtected: false,
    };
  }
  let synced = 0;
  let drift = false;
  let failed = 0;
  const needModify = legs.filter((p) => {
    const tpOk = brokerProtectionMatches({
      current: p.takeProfit,
      target: targets.takeProfit,
      point: targets.point,
    });
    const slOk = brokerProtectionMatches({
      current: p.stopLoss,
      target: targets.stopLoss,
      point: targets.point,
    });
    return !(tpOk && slOk);
  });
  if (needModify.length > 0) drift = true;
  // Same basket TP/SL targets — parallel POSITION_MODIFY cuts multi-leg latency
  const results = await Promise.all(
    needModify.map(async (p) => {
      const mod = await modifyPositionProtection({
        metaApiAccountId: opts.metaId,
        positionId: String(p.id),
        takeProfit: targets.takeProfit,
        stopLoss: targets.stopLoss,
      });
      return { p, mod };
    }),
  );
  for (const { p, mod } of results) {
    if (mod.ok) {
      synced += 1;
      p.takeProfit = targets.takeProfit ?? undefined;
      p.stopLoss = targets.stopLoss ?? undefined;
    } else {
      failed += 1;
      console.warn(
        `[engine] broker protect fail id=${p.id} ${opts.symbol} ${opts.direction}: ${mod.message}`,
      );
    }
  }
  const allProtected =
    failed === 0 &&
    legs.every(
      (p) =>
        brokerProtectionMatches({
          current: p.takeProfit,
          target: targets.takeProfit,
          point: targets.point,
        }) &&
        brokerProtectionMatches({
          current: p.stopLoss,
          target: targets.stopLoss,
          point: targets.point,
        }),
    );
  return {
    synced,
    skipped: false as const,
    drift,
    failed,
    targets,
    missingIds: legs.length === 0 && opts.positions.length > 0,
    allProtected,
  };
}

/** 예상 평단/로트로 지정가 미리 계산 (진입·DCA 동봉용) */
function previewProtectPrices(opts: {
  symbol: string;
  direction: "BUY" | "SELL";
  avgPrice: number;
  lots: number;
  takeProfitUsd: number;
  stopLossUsd: number;
  openPrices?: number[];
  stopsLevelPoints?: number;
  point?: number;
}) {
  const raw = basketExitPricesFromUsd({
    symbol: opts.symbol,
    direction: opts.direction,
    avgPrice: opts.avgPrice,
    lots: opts.lots,
    takeProfitUsd: opts.takeProfitUsd,
    stopLossUsd: opts.stopLossUsd,
  });
  const point = opts.point && opts.point > 0 ? opts.point : raw.point;
  const clamped = clampBasketProtectForLegs({
    direction: opts.direction,
    openPrices: opts.openPrices?.length ? opts.openPrices : [opts.avgPrice],
    takeProfit: raw.takeProfit,
    stopLoss: raw.stopLoss,
    point,
    stopsLevelPoints: opts.stopsLevelPoints,
  });
  return { ...raw, point, takeProfit: clamped.takeProfit, stopLoss: clamped.stopLoss };
}

/** 진입/DCA 직후 스냅샷 재조회 → 브로커 TP/SL 즉시 재설정 (실패 시 1회 재시도) */
async function refreshAndProtectBasket(opts: {
  metaId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  takeProfitPct: number;
  stopLossPct: number;
  stopLossEnabled: boolean;
  brokerLeverage?: number;
}) {
  if (!brokerProtectEnabled()) return { ok: false as const, reason: "disabled" };

  async function once() {
    const snap = await fetchSnapshot(opts.metaId);
    if (!snap.ok) return { ok: false as const, reason: snap.message };
    const positions = snap.positions.filter(
      (p) => symbolsMatch(p.symbol, opts.symbol) && p.direction === opts.direction,
    ) as PosRow[];
    if (positions.length === 0) return { ok: false as const, reason: "no_positions" };
    const lots = positions.reduce((s, p) => s + p.lots, 0);
    const avg =
      lots > 0 ? positions.reduce((s, p) => s + p.lots * p.price, 0) / lots : 0;
    const brokerMarginSum = positions.reduce(
      (s, p) => s + (typeof p.margin === "number" && p.margin > 0 ? p.margin : 0),
      0,
    );
    const liveUsd = liveBasketTpSlUsd({
      symbol: opts.symbol,
      lots,
      avgPrice: avg,
      takeProfitPct: opts.takeProfitPct,
      stopLossPct: opts.stopLossPct,
      brokerLeverage: opts.brokerLeverage,
      brokerMarginSum: brokerMarginSum > 0 ? brokerMarginSum : null,
    });
    const sync = await syncBrokerBasketProtection({
      metaId: opts.metaId,
      symbol: opts.symbol,
      direction: opts.direction,
      positions,
      avgPrice: avg,
      lots,
      takeProfitUsd: liveUsd.takeProfitUsd,
      stopLossUsd: liveUsd.stopLossUsd,
      stopLossEnabled: opts.stopLossEnabled,
    });
    if ((sync.failed ?? 0) > 0) {
      return { ok: false as const, reason: `modify_failed:${sync.failed}`, sync, liveUsd };
    }
    return { ok: true as const, sync, liveUsd };
  }

  let result = await once();
  if (!result.ok && result.reason !== "disabled") {
    await new Promise((r) => setTimeout(r, 400));
    result = await once();
  }
  if (!result.ok) {
    console.error(
      `[engine] protect refresh fail ${opts.symbol} ${opts.direction}: ${result.reason}`,
    );
  }
  return result;
}

/**
 * 포지션 API 공백(고스트)인데 DB 바스켓이 열린 경우 — 호가 ROI로 긴급 TP/SL 시도.
 * closePositionsBySymbolDirection 이 내부에서 스냅샷을 다시 보므로 지연 중에도 닫힐 수 있다.
 */
async function tryGhostBasketSoftExit(opts: {
  accountId: string;
  metaId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  basket: BasketRow;
  legs: { level: number; lots: number; price: number }[];
  bid: number;
  ask: number;
  logic: string;
  takeProfitPct: number;
  stopLossPct: number;
  stopLossEnabled: boolean;
  brokerLeverage?: number;
  allowReentry?: boolean;
  repeatEnabled?: boolean;
  reentryLots?: number;
}) {
  const lots = opts.legs.reduce((s, l) => s + l.lots, 0);
  const avg = avgPrice(opts.legs);
  if (!(lots > 0) || !(avg > 0)) return { handled: false as const };

  const liveUsd = liveBasketTpSlUsd({
    symbol: opts.symbol,
    lots,
    avgPrice: avg,
    takeProfitPct: opts.takeProfitPct,
    stopLossPct: opts.stopLossPct,
    brokerLeverage: opts.brokerLeverage,
  });
  const tpPnl = mt5PnlForTakeProfit({
    apiProfit: 0,
    symbol: opts.symbol,
    direction: opts.direction,
    legs: opts.legs.map((l) => ({ lots: l.lots, price: l.price })),
    bid: opts.bid,
    ask: opts.ask,
  });
  const tpDecision = shouldTriggerTakeProfit({
    pnl: tpPnl.pnl,
    takeProfitUsd: liveUsd.takeProfitUsd,
    usedMargin: liveUsd.marginUsd,
    tpRoiPct: liveUsd.takeProfitPct,
  });
  const slDecision = shouldTriggerStopLossUsd({
    pnl: tpPnl.pnlForSl,
    stopLossUsd: opts.stopLossEnabled ? liveUsd.stopLossUsd : 0,
    usedMargin: opts.stopLossEnabled ? liveUsd.marginUsd : 0,
    stopLossRoiPct: opts.stopLossEnabled ? liveUsd.stopLossPct : 0,
  });

  if (!tpDecision.hit && !slDecision.hit) return { handled: false as const };

  const kind = tpDecision.hit ? "TP" : "SL";

  // Lag guard: whole book empty + margin/float → positions may still exist (API lag).
  // Other-symbol float alone must NOT block this side's soft exit / DB close.
  const preClose = await fetchSnapshot(opts.metaId);
  if (preClose.ok) {
    const stillEmpty =
      positionsForSymbol(preClose.positions, opts.symbol, opts.direction).length === 0;
    if (
      stillEmpty &&
      shouldSkipGhostHealForAccountLag({
        positionsCount: preClose.positions.length,
        margin: Number(preClose.margin ?? 0),
        equity: Number(preClose.equity ?? 0),
        balance: Number(preClose.balance ?? 0),
      })
    ) {
      console.warn(
        `[engine] ghost soft-${kind} skipped account=${opts.accountId} ${opts.symbol} — whole-book margin/float lag guard`,
      );
      return {
        handled: true as const,
        result: {
          ok: true as const,
          action: "ghost_pending",
          symbol: opts.symbol,
          note: "await_ghost_heal_lag_guard",
        },
      };
    }
  }

  console.error(
    `[engine] ghost soft-${kind} attempt account=${opts.accountId} ${opts.symbol} ${opts.direction} roiTp=${tpDecision.floatingRoi.toFixed(2)} roiSl=${slDecision.floatingRoi.toFixed(2)}`,
  );
  const closeRes = await closePositionsBySymbolDirection(
    opts.metaId,
    opts.symbol,
    opts.direction,
  );
  const emptyUnverified =
    closeRes.ok &&
    (closeRes as { emptyWithoutClose?: boolean }).emptyWithoutClose === true &&
    (closeRes.closed ?? 0) === 0;

  // emptyWithoutClose: either lag OR already flat. Confirm with snap — if this side
  // is empty and book is healthy (other pos exist / account flat), reconcile DB basket.
  let reconcileEmpty = false;
  if (emptyUnverified) {
    const verify = await fetchSnapshot(opts.metaId);
    if (verify.ok) {
      const sideEmpty =
        positionsForSymbol(verify.positions, opts.symbol, opts.direction).length === 0;
      const otherPositionsExist = verify.positions.some(
        (p) =>
          !(
            symbolsMatch(p.symbol, opts.symbol) && p.direction === opts.direction
          ),
      );
      reconcileEmpty = canReconcileEmptyGhostSide({
        sideEmpty,
        otherPositionsExist,
        margin: Number(verify.margin ?? 0),
        equity: verify.equity,
        balance: verify.balance,
      });
    }
  }

  if (
    !closeRes.ok ||
    (closeRes.remaining ?? 0) > 0 ||
    (emptyUnverified && !reconcileEmpty)
  ) {
    await logTpMissGuard({
      accountId: opts.accountId,
      symbol: opts.symbol,
      direction: opts.direction,
      logic: opts.logic,
      floatingRoi: tpDecision.hit ? tpDecision.floatingRoi : slDecision.floatingRoi,
      tpRoi: tpDecision.tpRoi,
      tpMoney: tpDecision.tpMoney,
      pnl: tpDecision.hit ? tpPnl.pnl : tpPnl.pnlForSl,
      brokerTpMissing: true,
      reason: emptyUnverified
        ? `ghost_${kind.toLowerCase()}_empty_snap`
        : `ghost_${kind.toLowerCase()}_close_failed`,
    });
    return {
      handled: true as const,
      result: {
        ok: false as const,
        action: "ghost_close_failed",
        symbol: opts.symbol,
        error: emptyUnverified
          ? "ghost empty snap — skip basket close/reentry"
          : ("message" in closeRes && closeRes.message) || "ghost close failed",
      },
    };
  }

  if (reconcileEmpty) {
    console.warn(
      `[engine] ghost soft-${kind} reconcile empty side account=${opts.accountId} ${opts.symbol} ${opts.direction}`,
    );
  }

  const pnlSum = tpDecision.hit ? tpPnl.pnl : tpPnl.pnlForSl;
  await prisma.basket.update({
    where: { id: opts.basket.id },
    data: {
      status: "closed",
      realizedPnl: pnlSum,
      lastExitAt: new Date(),
      unrealizedPnl: 0,
    },
  });
  await prisma.fill.create({
    data: {
      accountId: opts.accountId,
      symbol: opts.symbol,
      side: opts.direction === "BUY" ? "SELL" : "BUY",
      lots,
      price: opts.direction === "BUY" ? opts.bid : opts.ask,
      pnl: pnlSum,
      kind,
      note: `${opts.logic}|ghost_soft_${kind}${reconcileEmpty ? "|reconcile_empty" : ""}|roi=${(tpDecision.hit ? tpDecision.floatingRoi : slDecision.floatingRoi).toFixed(2)}`,
    },
  });
  if (kind === "TP") {
    await prisma.brokerAccount.update({
      where: { id: opts.accountId },
      data: { tpCount: { increment: 1 }, cycleCount: { increment: 1 } },
    });
    if (opts.allowReentry !== false && opts.repeatEnabled !== false) {
      const re = await placeTpReentry({
        accountId: opts.accountId,
        metaId: opts.metaId,
        symbol: opts.symbol,
        direction: opts.direction,
        logic: opts.logic,
        reentryLots: opts.reentryLots ?? opts.legs[0]?.lots ?? 0.01,
        tpRoi: opts.takeProfitPct,
        stopLossPct: opts.stopLossPct,
        stopLossEnabled: opts.stopLossEnabled,
        brokerLeverage: opts.brokerLeverage,
        bid: opts.bid,
        ask: opts.ask,
        noteTag: reconcileEmpty
          ? "reentry_after_ghost_reconcile_tp"
          : "reentry_after_ghost_soft_tp",
      });
      if (!re.ok) {
        console.warn(
          `[engine] soft-TP reentry skip account=${opts.accountId} ${opts.symbol}: ${re.error}`,
        );
      } else {
        return {
          handled: true as const,
          result: {
            ok: true as const,
            action: "tp" as const,
            symbol: opts.symbol,
            floatingPnl: pnlSum,
            reentered: true,
          },
        };
      }
    }
  } else {
    await prisma.brokerAccount.update({
      where: { id: opts.accountId },
      data: { slCount: { increment: 1 } },
    });
  }
  return {
    handled: true as const,
    result: {
      ok: true as const,
      action: kind === "TP" ? ("tp" as const) : ("sl" as const),
      symbol: opts.symbol,
      floatingPnl: pnlSum,
    },
  };
}

async function forceCloseRemainder(opts: {
  metaId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  rounds?: number;
}) {
  const rounds = Math.max(1, opts.rounds ?? 2);
  let last: Awaited<ReturnType<typeof closePositionsBySymbolDirection>> | null = null;
  for (let i = 0; i < rounds; i++) {
    last = await closePositionsBySymbolDirection(opts.metaId, opts.symbol, opts.direction);
    if (last.ok && (last.remaining ?? 0) === 0) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  return last!;
}

/**
 * Fail-closed side close: never treat first-look empty snapshot as success when we
 * expected live positions (API lag → orphan DB close + false reentry).
 */
async function closeSideFailClosed(opts: {
  metaId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  expectedPositions: number;
}): Promise<
  | { ok: true; closed: number }
  | {
      ok: false;
      message: string;
      remaining?: number;
      unverifiedEmpty?: boolean;
    }
> {
  let closeRes = await closePositionsBySymbolDirection(
    opts.metaId,
    opts.symbol,
    opts.direction,
  );
  if (!closeRes.ok || (closeRes.remaining ?? 0) > 0) {
    closeRes = await forceCloseRemainder({
      metaId: opts.metaId,
      symbol: opts.symbol,
      direction: opts.direction,
    });
  }
  if (!closeRes.ok || (closeRes.remaining ?? 0) > 0) {
    return {
      ok: false,
      message:
        ("message" in closeRes && closeRes.message) ||
        `${opts.symbol} ${opts.direction} 청산 실패(잔여 ${"remaining" in closeRes ? closeRes.remaining : "?"})`,
      remaining: "remaining" in closeRes ? closeRes.remaining : undefined,
    };
  }

  const emptyUnverified =
    (closeRes as { emptyWithoutClose?: boolean }).emptyWithoutClose === true &&
    (closeRes.closed ?? 0) === 0;

  if (emptyUnverified && opts.expectedPositions > 0) {
    const verify = await fetchSnapshot(opts.metaId, {
      allowStaleMs: 0,
      allowStaleOnRateLimit: false,
    });
    if (!verify.ok) {
      return {
        ok: false,
        message: "close_unverified_empty_snap_fail",
        unverifiedEmpty: true,
      };
    }
    const still = positionsForSymbol(
      verify.positions,
      opts.symbol,
      opts.direction,
    );
    if (still.length > 0) {
      return {
        ok: false,
        message: "close_unverified_snap_lag",
        remaining: still.length,
        unverifiedEmpty: true,
      };
    }
  }

  return { ok: true, closed: closeRes.closed ?? 0 };
}

/**
 * Soft SL market-close with session backoff (mirrors soft TP).
 * Never force-closes through a closed session — broker SL remains the real protection.
 */
async function runSoftSlCloseAttempt(opts: {
  accountId: string;
  metaId: string;
  symbol: string;
  direction: "BUY" | "SELL";
}): Promise<
  | { ok: true; closed: true }
  | { ok: true; awaitSession: true; note: string }
  | { ok: false; message: string; remaining?: number }
> {
  const cool = await getSoftCloseCooldownShared({
    accountId: opts.accountId,
    symbol: opts.symbol,
    direction: opts.direction,
  });
  if (cool && isSessionTradeBackoffReason(cool.reason)) {
    return { ok: true, awaitSession: true, note: cool.reason };
  }
  // 폐장: 시장가 손절 금지 → 브로커 SL. 장중만 아래 시장가 청산.
  if (isFxMarketClosed()) {
    await noteSessionTradeBackoff({
      accountId: opts.accountId,
      symbol: opts.symbol,
      direction: opts.direction,
      reason: "fx_closed_await_broker_sl",
      ms: 30 * 60_000,
    });
    return { ok: true, awaitSession: true, note: "fx_market_closed" };
  }

  const slClose = await closeSideFailClosed({
    metaId: opts.metaId,
    symbol: opts.symbol,
    direction: opts.direction,
    expectedPositions: 1,
  });
  if (!slClose.ok) {
    const message = slClose.message;
    if (isMarketSessionBlockedError(message)) {
      await noteSessionTradeBackoff({
        accountId: opts.accountId,
        symbol: opts.symbol,
        direction: opts.direction,
        reason: "market_closed_await_broker_sl",
        ms: 20 * 60_000,
      });
      return { ok: true, awaitSession: true, note: "market_closed" };
    }
    return {
      ok: false,
      message,
      remaining: slClose.remaining,
    };
  }
  return { ok: true, closed: true };
}

/** After ENTRY/DCA order reject — back off when session is closed (holiday etc.). */
async function noteOrderRejectIfSessionClosed(opts: {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  message?: string;
  kind: "entry" | "dca";
}) {
  if (!isMarketSessionBlockedError(opts.message || "")) return;
  await noteSessionTradeBackoff({
    accountId: opts.accountId,
    symbol: opts.symbol,
    direction: opts.direction,
    reason: `market_closed_${opts.kind}`,
    ms: 20 * 60_000,
  });
}

async function logTpMissGuard(opts: {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  logic: string;
  floatingRoi: number;
  tpRoi: number;
  tpMoney: number;
  pnl: number;
  brokerTpMissing: boolean;
  reason: string;
  /** Skip spam when same key logged recently (market-closed storms). */
  throttleKey?: string;
  throttleMs?: number;
}) {
  const key = opts.throttleKey || softCloseKey(opts.accountId, opts.symbol, opts.direction);
  const throttleMs = opts.throttleMs ?? 5 * 60_000;
  const prev = softCloseCooldown.get(key);
  if (prev && prev.loggedAt > 0 && Date.now() - prev.loggedAt < throttleMs) {
    return;
  }
  const note = `tp_miss_guard|${opts.reason}|${opts.logic}|roi=${opts.floatingRoi.toFixed(2)}%>=${opts.tpRoi}%|pnl=${opts.pnl.toFixed(2)}|tp$${opts.tpMoney}|brokerTpMissing=${opts.brokerTpMissing ? 1 : 0}`;
  console.error(`[engine] ${note} account=${opts.accountId} ${opts.symbol} ${opts.direction}`);
  markSoftCloseLogged(key);
  try {
    await prisma.fill.create({
      data: {
        accountId: opts.accountId,
        symbol: opts.symbol,
        side: opts.direction === "BUY" ? "SELL" : "BUY",
        lots: 0,
        price: 0,
        pnl: opts.pnl,
        kind: "GUARD",
        note: note.slice(0, 500),
      },
    });
  } catch (e) {
    console.warn("[engine] tp_miss_guard fill skip", e instanceof Error ? e.message : e);
  }
}

/** Soft TP hit → market close with cooldown when session closed / broker TP already set. */
async function runSoftTpCloseAttempt(opts: {
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
  reentryLots: number;
  tpRoi: number;
  tpMoney: number;
  floatingRoi: number;
  pnlSum: number;
  pnlForGuard: number;
  allowReentry: boolean;
  stopLossPct?: number;
  stopLossEnabled?: boolean;
  brokerLeverage?: number;
  brokerTpMissing: boolean;
  spr?: number;
  profit?: number;
  tpPnl: { apiProfit: number; quotePnl: number; spreadCost: number; pnl: number };
}) {
  const key = softCloseKey(opts.accountId, opts.symbol, opts.direction);
  const cool = await getSoftCloseCooldownShared({
    accountId: opts.accountId,
    symbol: opts.symbol,
    direction: opts.direction,
  });
  if (cool) {
    return {
      ok: true as const,
      action: "tp_await_session" as const,
      symbol: opts.symbol,
      note: cool.reason,
      tpRoi: opts.tpRoi,
      tpMoney: opts.tpMoney,
      floatingPnl: opts.pnlForGuard,
      floatingRoi: opts.floatingRoi,
      spreadPct: opts.spr,
    };
  }

  // ── 폐장: 시장가 익절 금지, 브로커 TP만. ──
  if (isFxMarketClosed()) {
    await noteSoftCloseBackoffShared({
      accountId: opts.accountId,
      symbol: opts.symbol,
      direction: opts.direction,
      reason: "fx_closed_await_broker_tp",
      ms: 30 * 60_000,
    });
    return {
      ok: true as const,
      action: "tp_await_session" as const,
      symbol: opts.symbol,
      note: "fx_market_closed",
      tpRoi: opts.tpRoi,
      tpMoney: opts.tpMoney,
      floatingPnl: opts.pnlForGuard,
      floatingRoi: opts.floatingRoi,
      spreadPct: opts.spr,
    };
  }

  // ── 장중: 마진 ROI TP면 시장가 익절 (브로커 TP 유무와 무관). ──
  // 브로커 TP는 물타기 클램프 때문에 ROI(~0.04%)보다 멀 수 있음.
  if (!isFxMarketOpen()) {
    // defensive — getFxMarketSession closed/open are complements
    return {
      ok: true as const,
      action: "tp_await_session" as const,
      symbol: opts.symbol,
      note: "fx_market_closed",
      tpRoi: opts.tpRoi,
      tpMoney: opts.tpMoney,
      floatingPnl: opts.pnlForGuard,
      floatingRoi: opts.floatingRoi,
      spreadPct: opts.spr,
    };
  }

  if (opts.brokerTpMissing) {
    await logTpMissGuard({
      accountId: opts.accountId,
      symbol: opts.symbol,
      direction: opts.direction,
      logic: opts.logic,
      floatingRoi: opts.floatingRoi,
      tpRoi: opts.tpRoi,
      tpMoney: opts.tpMoney,
      pnl: opts.pnlForGuard,
      brokerTpMissing: true,
      reason: "soft_tp_hit_broker_unset",
      throttleKey: key,
    });
  }

  const tpClose = await closeBasketTp({
    accountId: opts.accountId,
    metaId: opts.metaId,
    symbol: opts.symbol,
    direction: opts.direction,
    basket: opts.basket,
    legs: opts.legs,
    ourPositions: opts.ourPositions,
    bid: opts.bid,
    ask: opts.ask,
    logic: opts.logic,
    repeatEnabled: opts.repeatEnabled,
    reentryLots: opts.reentryLots,
    tpRoi: opts.tpRoi,
    tpMoney: opts.tpMoney,
    pnlSum: opts.pnlSum,
    floatingRoi: opts.floatingRoi,
    allowReentry: opts.allowReentry,
    stopLossPct: opts.stopLossPct,
    stopLossEnabled: opts.stopLossEnabled,
    brokerLeverage: opts.brokerLeverage,
  });

  if (!tpClose.closed) {
    const marketClosed = isMarketSessionBlockedError(tpClose.error);
    const reason = marketClosed
      ? "market_closed_await_broker_tp"
      : opts.brokerTpMissing
        ? "soft_close_failed"
        : "soft_close_failed_broker_tp_set";
    // Market closed / broker TP already on → long backoff (no trade storm).
    const backoffMs = marketClosed
      ? 20 * 60_000
      : opts.brokerTpMissing
        ? 45_000
        : 10 * 60_000;
    await noteSoftCloseBackoffShared({
      accountId: opts.accountId,
      symbol: opts.symbol,
      direction: opts.direction,
      reason,
      ms: backoffMs,
    });
    await logTpMissGuard({
      accountId: opts.accountId,
      symbol: opts.symbol,
      direction: opts.direction,
      logic: opts.logic,
      floatingRoi: opts.floatingRoi,
      tpRoi: opts.tpRoi,
      tpMoney: opts.tpMoney,
      pnl: opts.pnlForGuard,
      brokerTpMissing: opts.brokerTpMissing,
      reason,
      throttleKey: key,
      throttleMs: 5 * 60_000,
    });
    return {
      ok: true as const,
      action: "tp_await_session" as const,
      symbol: opts.symbol,
      error: tpClose.error || "익절 청산 실패",
      note: reason,
      tpRoi: opts.tpRoi,
      tpMoney: opts.tpMoney,
      floatingPnl: opts.pnlForGuard,
      floatingRoi: opts.floatingRoi,
      spreadPct: opts.spr,
    };
  }

  softCloseCooldown.delete(key);
  return {
    ok: true as const,
    action: "tp" as const,
    symbol: opts.symbol,
    tpRoi: opts.tpRoi,
    tpMoney: opts.tpMoney,
    floatingPnl: opts.tpPnl.apiProfit,
    floatingRoi: opts.floatingRoi,
    apiProfit: opts.tpPnl.apiProfit,
    quotePnl: opts.tpPnl.quotePnl,
    spreadCost: opts.tpPnl.spreadCost,
    profit: opts.profit,
    reentered: tpClose.reentered,
    reentryError: tpClose.error,
    spreadPct: opts.spr,
  };
}

function positionsForSymbol(
  positions: PosRow[],
  symbol: string,
  direction?: "BUY" | "SELL",
) {
  return positions.filter(
    (p) => symbolsMatch(p.symbol, symbol) && (!direction || p.direction === direction),
  );
}

function sleepMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** DB legs ahead of live volume — real mismatch (not 1-tick snapshot lag). */
/**
 * Fail-closed guard: is the broker already holding more than the ladder says?
 *
 * confirmLiveVolumeIncreased() can time out while the order still lands at the
 * broker a moment later. The leg is then never written, basket.filledLevel stays
 * put, and the next tick re-orders the same rung — silently doubling the
 * position. Observed 2026-08-08 on a live GBPUSD basket: DB 10.16 lots vs broker
 * 31.28 lots, -5,936 unrealized.
 *
 * 10% tolerance (min 0.02 lots) absorbs partial fills and rounding without
 * letting a whole extra rung through.
 */
export function shouldBlockDcaForLotDivergence(opts: {
  ladderLots: number;
  brokerLots: number;
}) {
  if (!(opts.ladderLots > 0)) return false;
  const tolerance = Math.max(0.02, opts.ladderLots * 0.1);
  return opts.brokerLots > opts.ladderLots + tolerance;
}

export function shouldSoftReconcileLegLag(opts: {
  dbLegCount: number;
  livePosCount: number;
  dbLots: number;
  liveLots: number;
}) {
  if (opts.livePosCount <= 0) return false;
  if (opts.dbLegCount <= opts.livePosCount) return false;
  const lotGap = opts.dbLots - opts.liveLots;
  // >1 min-lot of phantom volume, or DB volume ≥1.5× live
  return lotGap >= 0.015 || opts.dbLots >= opts.liveLots * 1.5 + 0.001;
}

/** Map live positions → DB legs (BUY: high→low price as L0..; SELL: low→high). */
export function planLegsFromLivePositions(
  positions: Array<{ lots: number; price: number }>,
  direction: "BUY" | "SELL",
) {
  const sorted = [...positions].sort((a, b) =>
    direction === "BUY" ? b.price - a.price : a.price - b.price,
  );
  return sorted.map((p, i) => ({
    level: i,
    lots: Math.round(p.lots * 100) / 100,
    price: p.price,
  }));
}

async function confirmLiveVolumeIncreased(opts: {
  metaId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  beforeLots: number;
  expectedAdd: number;
}): Promise<
  | { ok: true; afterLots: number; fillPrice: number; addedLots: number }
  | { ok: false; afterLots: number }
> {
  const need = opts.beforeLots + Math.max(0.01, opts.expectedAdd) * 0.85;
  let afterLots = opts.beforeLots;
  let fillPrice = 0;
  // 기존 5회/약 3.4초는 브로커가 붐빌 때 늦은 체결을 놓쳤다. 놓치면 레그가
  // 기록되지 않은 채 주문만 체결돼 DB/브로커 물량이 영구히 어긋난다
  // (2026-08-08 실계좌 10.16 vs 31.28 lots). 창을 넓혀 고아 레그를 줄인다.
  // DCA/진입 때만 도는 경로라 틱 예산(ENGINE_BUDGET_MS 600s)에 여유가 있다.
  const attempts = Math.max(5, Number(process.env.METAAPI_CONFIRM_ATTEMPTS || 8));
  const stepMs = Math.max(300, Number(process.env.METAAPI_CONFIRM_STEP_MS || 900));
  for (let i = 0; i < attempts; i++) {
    await sleepMs(i === 0 ? 350 : stepMs);
    const snap = await fetchSnapshot(opts.metaId, {
      allowStaleMs: 0,
      allowStaleOnRateLimit: false,
    });
    if (!snap.ok) continue;
    const side = positionsForSymbol(snap.positions, opts.symbol, opts.direction);
    afterLots = side.reduce((s, p) => s + p.lots, 0);
    if (afterLots >= need - 1e-9) {
      const newest = [...side].sort((a, b) => b.lots - a.lots)[0];
      fillPrice = newest?.price ?? 0;
      // 하한만 보면 초과 체결(같은 주문이 두 번 나간 경우)을 통과시킨다.
      // 그러면 DB에는 의도한 1회분 레그만 남아 브로커와 영구히 어긋난다.
      // 상한을 넘으면 드러낸다 — 레그는 실제 증가분으로 기록해야 한다.
      const added = afterLots - opts.beforeLots;
      const overLimit = Math.max(0.01, opts.expectedAdd) * 1.5;
      if (added > overLimit + 1e-9) {
        console.error(
          `[engine] OVER-FILL account=${opts.metaId} ${opts.symbol} ${opts.direction} — ` +
            `expected +${opts.expectedAdd.toFixed(2)} but broker added +${added.toFixed(2)} lots ` +
            `(before=${opts.beforeLots.toFixed(2)} after=${afterLots.toFixed(2)}). ` +
            `같은 주문이 중복 발행됐을 수 있다. 레그는 실제 증가분으로 기록한다.`,
        );
      }
      return { ok: true, afterLots, fillPrice, addedLots: added };
    }
  }
  return { ok: false, afterLots };
}

async function softReconcileBasketLegsToLive(opts: {
  accountId: string;
  basketId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  live: Array<{ lots: number; price: number; profit: number }>;
}) {
  const planned = planLegsFromLivePositions(opts.live, opts.direction);
  if (planned.length === 0) return null;
  await prisma.$transaction(async (tx) => {
    await tx.basketLeg.deleteMany({ where: { basketId: opts.basketId } });
    await tx.basketLeg.createMany({
      data: planned.map((l) => ({
        basketId: opts.basketId,
        level: l.level,
        lots: l.lots,
        price: l.price,
      })),
    });
    await tx.basket.update({
      where: { id: opts.basketId },
      data: {
        filledLevel: planned.length - 1,
        firstEntryPrice: planned[0]!.price,
        unrealizedPnl: opts.live.reduce((s, p) => s + p.profit, 0),
      },
    });
    await tx.fill.create({
      data: {
        accountId: opts.accountId,
        symbol: opts.symbol,
        side: opts.direction,
        lots: planned.reduce((s, l) => s + l.lots, 0),
        price: planned[0]!.price,
        pnl: 0,
        kind: "GUARD",
        note: `leg_lag_reconcile|db→live|legs=${planned.length}`,
      },
    });
  });
  console.warn(
    `[engine] leg lag reconcile account=${opts.accountId} ${opts.symbol} ${opts.direction} → liveLegs=${planned.length}`,
  );
  return planned;
}

/** 신규 진입·물타기·익절후재진입 허용 여부 (틱 중 토글 반영) */
async function canOpenNewRisk(
  accountId: string,
  symbol: string,
  direction: "BUY" | "SELL",
) {
  // 폐장: 신규·물타기·재진입 금지 (0 MetaAPI). TP/SL 관리 경로는 이 함수를 안 탐.
  if (isFxMarketClosed()) return false;
  const [account, bots] = await Promise.all([
    prisma.brokerAccount.findUnique({
      where: { id: accountId },
      select: { botEnabled: true, skipOpenBurstEntries: true },
    }),
    prisma.symbolBot.findMany({
      where: { accountId, symbol },
      select: { enabled: true, direction: true, dualDirection: true, logic: true },
    }),
  ]);
  if (!account?.botEnabled) return false;
  // Open-burst quiet: block ENTRY/DCA/reentry only — TP/SL management continues.
  if (account.skipOpenBurstEntries) {
    const quiet = isInOpenBurstQuietPeriod();
    if (quiet.active) return false;
  }
  return bots.some((b) => {
    if (!b.enabled) return false;
    // H8 time logics pick direction from bar open — DB direction is ignored
    if (isMartin9TimeLogic(b.logic)) return true;
    if (b.dualDirection) return true;
    return (b.direction === "SELL" ? "SELL" : "BUY") === direction;
  });
}

/** Persist backoff so ENTRY/DCA/SL do not burn trade credits every tick while closed. */
async function noteSessionTradeBackoff(opts: {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  reason: string;
  ms?: number;
}) {
  await noteSoftCloseBackoffShared({
    accountId: opts.accountId,
    symbol: opts.symbol,
    direction: opts.direction,
    reason: opts.reason,
    ms: opts.ms ?? 20 * 60_000,
  });
}

/**
 * Fail-closed L0 gate: skip market entry when equity cannot cover estimated MT5 margin.
 * Uses contract-size–aware mt5UsedMargin (XAU 0.01 ≈ $8–9 at 1:500) — never price*lots/lev alone.
 */
async function skipEntryIfMarginInsufficient(opts: {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  fillPrice: number;
  brokerLeverage?: number;
}): Promise<{ skip: true; note: string; estMargin: number; equity: number } | { skip: false }> {
  const estMargin = mt5UsedMargin({
    symbol: opts.symbol,
    lots: opts.lots,
    avgPrice: opts.fillPrice,
    brokerLeverage: opts.brokerLeverage || MT5_BROKER_LEVERAGE_DEFAULT,
  });
  const eqRow = await prisma.brokerAccount.findUnique({
    where: { id: opts.accountId },
    select: { equity: true, liveState: true },
  });
  const equity = Number(eqRow?.equity || 0);
  const live = (eqRow?.liveState || {}) as { freeMargin?: number; margin?: number };
  const freeMargin =
    typeof live.freeMargin === "number" && Number.isFinite(live.freeMargin)
      ? live.freeMargin
      : null;
  // Prefer freeMargin when known; else equity. Buffer 15%.
  const budget = freeMargin != null && freeMargin >= 0 ? freeMargin : equity;
  if (budget > 0 && estMargin > 0 && budget < estMargin * 1.15) {
    console.warn(
      `[engine] skip entry margin account=${opts.accountId} ${opts.symbol} budget=${budget.toFixed(2)} (free=${freeMargin ?? "n/a"} eq=${equity.toFixed(2)}) need~${estMargin.toFixed(2)} lots=${opts.lots}`,
    );
    await noteSessionTradeBackoff({
      accountId: opts.accountId,
      symbol: opts.symbol,
      direction: opts.direction,
      reason: "margin_insufficient_for_lots",
      ms: 30 * 60_000,
    });
    return { skip: true, note: "margin_insufficient_skip", estMargin, equity };
  }
  return { skip: false };
}

/** 손절후중지 / 익절후미반복 — dualDirection 행까지 함께 끔 (H8 time 제외) */
async function disableSymbolBotSide(
  accountId: string,
  symbol: string,
  direction: "BUY" | "SELL",
) {
  const rows = await prisma.symbolBot.findMany({
    where: {
      accountId,
      symbol,
      enabled: true,
      OR: [{ direction }, { dualDirection: true }],
    },
    select: { id: true, logic: true, direction: true, dualDirection: true, enabled: true, symbol: true },
  });
  const ids = rows.filter(shouldDisableOnSideStop).map((r) => r.id);
  if (ids.length === 0) return;
  await prisma.symbolBot.updateMany({
    where: { id: { in: ids } },
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
 * Ghost DB close is allowed only when deal history is healthy AND an OUT deal exists.
 * Fail-closed: hist miss / empty deals → leave basket open (blocks stacked ENTRY).
 */
export function canHealGhostBasketFromDeals(opts: {
  histOk: boolean;
  hasOutDeal: boolean;
}): boolean {
  return opts.histOk === true && opts.hasOutDeal === true;
}

/**
 * Lag guard for ghost heal: ONLY when the entire position book is empty but
 * margin/float still says risk is open (classic MetaAPI sync lag).
 * Multi-symbol accounts with float on OTHER pairs must NOT block this-symbol heal.
 */
export function shouldSkipGhostHealForAccountLag(opts: {
  positionsCount: number;
  margin: number;
  equity: number;
  balance: number;
}): boolean {
  if ((opts.positionsCount ?? 0) > 0) return false;
  const margin = Number(opts.margin ?? 0);
  const equity = Number(opts.equity ?? 0);
  const balance = Number(opts.balance ?? 0);
  return (
    margin > GHOST_LAG_MARGIN_USD ||
    (balance > 0 &&
      equity > 0 &&
      Math.abs(balance - equity) > GHOST_LAG_FLOAT_USD)
  );
}

/**
 * This symbol+direction is empty on snap. Safe to close the DB ghost when:
 * - other live positions exist (book is healthy; this side really flat), OR
 * - whole account is flat (no margin/float lag signal).
 */
export function canReconcileEmptyGhostSide(opts: {
  sideEmpty: boolean;
  otherPositionsExist: boolean;
  margin: number;
  equity: number;
  balance: number;
}): boolean {
  if (!opts.sideEmpty) return false;
  if (opts.otherPositionsExist) return true;
  return !shouldSkipGhostHealForAccountLag({
    positionsCount: 0,
    margin: opts.margin,
    equity: opts.equity,
    balance: opts.balance,
  });
}

export function ghostBasketAgeMs(
  basket: { createdAt?: Date | string; updatedAt?: Date | string },
  now = Date.now(),
): number {
  const raw = basket.createdAt ?? basket.updatedAt;
  if (!raw) return 0;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(0, now - t);
}

/**
 * Backup/Vercel ticks should manage open baskets only — no new ENTRY/DCA.
 * Primary Render engine uses ENGINE_MODE=direct and never sets this.
 */
export function resolveForceManageOnly(opts?: { forceManageOnly?: boolean }): boolean {
  if (opts?.forceManageOnly === true) return true;
  const env = (process.env.ENGINE_BACKUP_MANAGE_ONLY || "").trim().toLowerCase();
  if (env === "1" || env === "true" || env === "on") return true;
  return false;
}

/**
 * DB엔 열린 바스켓이 있는데 MT5 포지션이 없음 = 동기화 불일치(API 지연·이미 청산됨).
 * OUT deal 증거가 있을 때만 DB 바스켓을 닫는다. hist 실패·증거 없음 → fail-closed(유지).
 * 봇은 절대 끄지 않는다. true면 심볼 루프는 계속 진행(신규 진입/익절·손절 유지).
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

  // Whole-book empty + margin/float → API lag. Other-symbol float must not block.
  if (
    shouldSkipGhostHealForAccountLag({
      positionsCount: positions.length,
      margin: opts?.margin ?? 0,
      equity: opts?.equity ?? 0,
      balance: opts?.balance ?? 0,
    })
  ) {
    console.warn(
      `[engine] skip ghost-heal account=${accountId} — whole-book lag margin=${opts?.margin ?? 0} eq=${opts?.equity ?? 0} bal=${opts?.balance ?? 0}`,
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

  if (
    shouldSkipGhostHealForAccountLag({
      positionsCount: again.positions.length,
      margin: Number(again.margin ?? 0),
      equity: again.equity,
      balance: again.balance,
    })
  ) {
    return false;
  }

  const earliestCreated = stillGhost.reduce((min, g) => {
    const t = g.createdAt ? new Date(g.createdAt).getTime() : Date.now();
    return Number.isFinite(t) ? Math.min(min, t) : min;
  }, Date.now());
  const histStart = new Date(
    Math.max(earliestCreated - 60_000, Date.now() - GHOST_DEAL_HIST_MAX_MS),
  );
  const hist = await fetchHistoryDeals(metaId, histStart, new Date());
  if (!hist.ok) {
    console.warn(
      `[engine] skip ghost-heal account=${accountId} — history unavailable (fail-closed)`,
    );
    return false;
  }
  const deals = hist.deals;

  let healed = 0;
  for (const g of stillGhost) {
    const dir = g.direction === "SELL" ? "SELL" : "BUY";
    // OUT deal that closes a BUY basket is typically DEAL_TYPE_SELL (and vice versa).
    const closeDealType = dir === "BUY" ? "DEAL_TYPE_SELL" : "DEAL_TYPE_BUY";
    const dirDeals = deals.filter(
      (d) =>
        symbolsMatch(d.symbol || "", g.symbol) &&
        String(d.entryType || "").includes("OUT") &&
        String(d.type || "") === closeDealType,
    );
    const symDeals =
      dirDeals.length > 0
        ? dirDeals
        : deals.filter(
            (d) =>
              symbolsMatch(d.symbol || "", g.symbol) &&
              String(d.entryType || "").includes("OUT"),
          );
    const basketCreatedMs = g.createdAt ? new Date(g.createdAt).getTime() : 0;
    const last = symDeals
      .filter((d) => {
        const t = new Date(d.time || 0).getTime();
        return !basketCreatedMs || !Number.isFinite(t) || t >= basketCreatedMs - 60_000;
      })
      .sort(
        (a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime(),
      )[0];
    const hasOut = !!last;
    const sideEmpty = true;
    const otherPositionsExist = again.positions.some(
      (p) =>
        !(symbolsMatch(p.symbol, g.symbol) && p.direction === dir),
    );
    const canStaleReconcile =
      !hasOut &&
      ghostBasketAgeMs(g) >= GHOST_STALE_RECONCILE_MS &&
      canReconcileEmptyGhostSide({
        sideEmpty,
        otherPositionsExist,
        margin: Number(again.margin ?? 0),
        equity: again.equity,
        balance: again.balance,
      });

    if (
      !canHealGhostBasketFromDeals({
        histOk: true,
        hasOutDeal: hasOut,
      }) &&
      !canStaleReconcile
    ) {
      console.warn(
        `[engine] keep ghost basket account=${accountId} ${g.symbol} ${dir} — no OUT deal proof`,
      );
      continue;
    }
    const pnl = hasOut
      ? Number(last.profit || 0) +
        Number(last.swap || 0) +
        Number(last.commission || 0)
      : 0;
    const reason = hasOut
      ? String(last?.reason || "").toLowerCase()
      : "stale_empty_reconcile";
    const explicitSl = reason.includes("sl") || reason.includes("stop");
    const explicitTp = reason.includes("tp") || reason.includes("take");
    // Never infer TP from PnL sign — false reentry after lag/manual exits.
    const kind = !hasOut
      ? "GUARD"
      : explicitSl
        ? "SL"
        : explicitTp
          ? "TP"
          : "GUARD";

    await prisma.basket.update({
      where: { id: g.id },
      data: {
        status: "closed",
        lastExitAt: new Date(),
        unrealizedPnl: 0,
        realizedPnl: pnl,
      },
    });
    await prisma.fill.create({
      data: {
        accountId,
        symbol: g.symbol,
        side: dir === "BUY" ? "SELL" : "BUY",
        lots: g.legs.reduce((s, l) => s + l.lots, 0),
        price: Number(last?.price || g.firstEntryPrice || 0),
        pnl,
        kind,
        note: hasOut
          ? `ghost_deal|${kind}|reason=${reason || "unclassified"}`
          : `ghost_reconcile_stale_empty|${g.symbol}|${dir}|ageMs=${ghostBasketAgeMs(g)}`,
      },
    });
    healed += 1;
    if (kind === "TP") {
      await prisma.brokerAccount.update({
        where: { id: accountId },
        data: { tpCount: { increment: 1 }, cycleCount: { increment: 1 } },
      });
      // Broker-side TP left DB ghost — reenter L0 for fixed logics + H8 time (same bar).
      const sideBots = await prisma.symbolBot.findMany({
        where: { accountId, symbol: g.symbol },
      });
      const bot = resolveEnabledFixedBotForSide({
        bots: sideBots,
        symbol: g.symbol,
        direction: dir,
      });
      if (bot && bot.repeatEnabled !== false && !isMartin9TimeLogic(bot.logic)) {
        const logic = bot.logic || "dubai_bruno_313";
        const lots = Math.max(0.01, Number(bot.startLots || 0.01));
        const tpRoi = resolveLiveTakeProfitPct(logic, bot.takeProfitPct ?? 0);
        const slPct = resolveLiveStopLossPct(logic, bot.stopLossPct ?? 0);
        const re = await placeTpReentry({
          accountId,
          metaId,
          symbol: g.symbol,
          direction: dir,
          logic,
          reentryLots: lots,
          tpRoi,
          stopLossPct: slPct,
          stopLossEnabled: bot.stopLossEnabled ?? true,
          noteTag: "reentry_after_broker_tp",
        });
        if (!re.ok) {
          console.warn(
            `[engine] broker-TP reentry skip account=${accountId} ${g.symbol} ${dir}: ${re.error}`,
          );
        }
      } else {
        // H8 time: keep trading session direction until next bar flatten.
        const timeBot = sideBots.find(
          (b) =>
            b.enabled &&
            isMartin9TimeLogic(b.logic) &&
            symbolsMatch(b.symbol, g.symbol),
        );
        if (timeBot && timeBot.repeatEnabled !== false && canH8Enter() && !isInH8EntryQuiet()) {
          const logic = normalizeLogicId(timeBot.logic);
          const h8Sk = h8StateKey(accountId, g.symbol, logic);
          let st = h8SessionState.get(h8Sk);
          if (!st) {
            st = (await loadH8StateFromDb(accountId, g.symbol, logic)) ?? undefined;
            if (st) h8SessionState.set(h8Sk, st);
          }
          const reDir =
            st?.direction === "BUY" || st?.direction === "SELL" ? st.direction : dir;
          if (st?.barOpen != null) {
            const lots = Math.max(0.01, Number(timeBot.startLots || 0.01));
            const tpRoi = resolveLiveTakeProfitPct(logic, timeBot.takeProfitPct ?? 0);
            const slPct = resolveLiveStopLossPct(logic, timeBot.stopLossPct ?? 0);
            const re = await placeTpReentry({
              accountId,
              metaId,
              symbol: g.symbol,
              direction: reDir,
              logic,
              reentryLots: lots,
              tpRoi,
              stopLossPct: slPct,
              stopLossEnabled: timeBot.stopLossEnabled ?? true,
              noteTag: "reentry_after_broker_tp_h8",
            });
            if (!re.ok) {
              console.warn(
                `[engine] H8 broker-TP reentry skip account=${accountId} ${g.symbol} ${reDir}: ${re.error}`,
              );
            } else if (st) {
              st.entered = true;
              st.direction = reDir;
              await rememberH8State(accountId, g.symbol, logic, st);
            }
          }
        }
      }
    } else if (kind === "SL") {
      await prisma.brokerAccount.update({
        where: { id: accountId },
        data: { slCount: { increment: 1 } },
      });
      // stopOnSl: best-effort disable matching fixed symbol bots (never H8 time)
      const bots = await prisma.symbolBot.findMany({
        where: { accountId, symbol: g.symbol, stopOnSl: true },
        select: {
          symbol: true,
          direction: true,
          dualDirection: true,
          enabled: true,
          logic: true,
        },
      });
      for (const b of bots) {
        if (!shouldDisableOnSideStop(b)) continue;
        if (b.dualDirection || (b.direction === "SELL" ? "SELL" : "BUY") === dir) {
          await disableSymbolBotSide(accountId, g.symbol, dir);
        }
      }
    }
  }

  if (healed > 0) {
    console.warn(
      `[engine] healed ${healed}/${stillGhost.length} ghost basket(s) account=${accountId} via deals — bot stays ON`,
    );
  }
  return healed > 0;
}

/**
 * Same-tick L0 reentry after TP (broker soft/ghost or engine TP).
 */

async function gateNewRiskOrder(opts: {
  accountId: string;
  metaId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  level: number;
  livePositions?: Array<{ takeProfit?: number; stopLoss?: number }>;
}): Promise<{ ok: true } | { ok: false; note: string }> {
  // 폐장: ENTRY/DCA 게이트 차단 (장중만 통과)
  if (isFxMarketClosed()) {
    return { ok: false, note: "fx_market_closed" };
  }
  const sessionCool = await getSoftCloseCooldownShared({
    accountId: opts.accountId,
    symbol: opts.symbol,
    direction: opts.direction,
  });
  // Any shared backoff blocks new risk (margin / ACK-without-fill / session closed).
  // Previously only session_closed matched — tiny XAU accounts burned credits every tick.
  if (sessionCool) {
    return { ok: false, note: sessionCool.reason || "soft_close_cd" };
  }
  await syncTradeCreditPauseFromDb();
  if (metaApiTradeCreditBlocked()) {
    return { ok: false, note: "trade_credit_blocked" };
  }
  const idem = await assertLevelNotAlreadyOpen({
    accountId: opts.accountId,
    symbol: opts.symbol,
    direction: opts.direction,
    level: opts.level,
  });
  if (!idem.ok) return { ok: false, note: idem.reason };
  if (opts.level > 0 && opts.livePositions && positionsAreNaked(opts.livePositions)) {
    return { ok: false, note: "dca_blocked_naked" };
  }
  const fresh = await fetchSnapshot(opts.metaId, {
    allowStaleMs: 2_500,
    allowStaleOnRateLimit: false,
  });
  if (!fresh.ok) {
    return { ok: false, note: `snap_${fresh.code}` };
  }
  return { ok: true };
}

async function placeTpReentry(opts: {
  accountId: string;
  metaId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  logic: string;
  reentryLots: number;
  tpRoi: number;
  stopLossPct?: number;
  stopLossEnabled?: boolean;
  brokerLeverage?: number;
  bid?: number;
  ask?: number;
  noteTag?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const {
    accountId,
    metaId,
    symbol,
    direction,
    logic,
    reentryLots,
    tpRoi,
    stopLossPct,
    stopLossEnabled = true,
    brokerLeverage,
    noteTag = "reentry_after_tp",
  } = opts;

  if (!(await canOpenNewRisk(accountId, symbol, direction))) {
    return { ok: false, error: "reentry_blocked_toggle" };
  }
  {
    const cool = await getSoftCloseCooldownShared({ accountId, symbol, direction });
    if (cool) {
      return { ok: false, error: `reentry_soft_close_cd|${cool.reason}` };
    }
  }
  await syncTradeCreditPauseFromDb();
  if (metaApiTradeCreditBlocked()) {
    return { ok: false, error: "reentry_blocked_trade_credit" };
  }
  const idem = await assertLevelNotAlreadyOpen({
    accountId,
    symbol,
    direction,
    level: 0,
  });
  if (!idem.ok) {
    return { ok: false, error: `reentry_idempotent:${idem.reason}` };
  }

  let bid = opts.bid ?? 0;
  let ask = opts.ask ?? 0;
  if (!(bid > 0 && ask > 0)) {
    const price = await getSymbolPrice(metaId, symbol);
    if (!price || !(price.bid > 0 && price.ask > 0)) {
      return { ok: false, error: `${symbol} 재진입 시세 없음` };
    }
    bid = price.bid;
    ask = price.ask;
  }

  const lots = Math.max(0.01, Math.round(reentryLots * 100) / 100);
  const fillPrice = mt5EntryQuote(direction, bid, ask);
  {
    const marginGate = await skipEntryIfMarginInsufficient({
      accountId,
      symbol,
      direction,
      lots,
      fillPrice,
      brokerLeverage,
    });
    if (marginGate.skip) {
      return { ok: false, error: marginGate.note };
    }
  }
  const reentryTpPct = tpRoi > 0 ? tpRoi : 20;
  const reentrySlPct =
    stopLossPct != null && stopLossPct > 0 ? stopLossPct : DCA1000_DEFAULT_SL_ROI;
  const reentryLive = liveBasketTpSlUsd({
    symbol,
    lots,
    avgPrice: fillPrice,
    takeProfitPct: reentryTpPct,
    stopLossPct: reentrySlPct,
    brokerLeverage: brokerLeverage || MT5_BROKER_LEVERAGE_DEFAULT,
    brokerMarginSum: null,
  });
  let stopsLevelPoints = 0;
  try {
    stopsLevelPoints = (await getSymbolTradeSpec(metaId, symbol)).stopsLevel;
  } catch {
    /* ignore */
  }
  const reentryPx = previewProtectPrices({
    symbol,
    direction,
    avgPrice: fillPrice,
    lots,
    takeProfitUsd: reentryLive.takeProfitUsd,
    stopLossUsd: stopLossEnabled ? reentryLive.stopLossUsd : 0,
    openPrices: [fillPrice],
    stopsLevelPoints,
  });
  let order = await placeMarketOrder({
    metaApiAccountId: metaId,
    symbol,
    direction,
    lots,
    comment: `SA-${logic.replace(/[^a-z0-9_]/gi, "").slice(0, 10) || "tp"}-L0`,
    takeProfit: reentryPx.takeProfit,
    stopLoss: reentryPx.stopLoss,
  });
  if (
    !order.ok &&
    (reentryPx.takeProfit != null || reentryPx.stopLoss != null) &&
    !metaApiTradeCreditBlocked()
  ) {
    order = await placeMarketOrder({
      metaApiAccountId: metaId,
      symbol,
      direction,
      lots,
      comment: `SA-${logic.replace(/[^a-z0-9_]/gi, "").slice(0, 10) || "tp"}-L0`,
    });
  }
  if (!order.ok) {
    await noteOrderRejectIfSessionClosed({
      accountId,
      symbol,
      direction,
      message: order.message,
      kind: "entry",
    });
    return { ok: false, error: order.message || "익절 후 재진입 주문 실패" };
  }
  const reentryConfirm = await confirmLiveVolumeIncreased({
    metaId,
    symbol,
    direction,
    beforeLots: 0,
    expectedAdd: lots,
  });
  if (!reentryConfirm.ok) {
    console.warn(
      `[engine] reentry order ok but volume missing account=${accountId} ${symbol} ${direction} liveLots=${reentryConfirm.afterLots}`,
    );
    await noteSessionTradeBackoff({
      accountId,
      symbol,
      direction,
      reason: "entry_ok_but_not_on_book",
      ms: 3 * 60_000,
    });
    return { ok: false, error: "entry_ok_but_not_on_book" };
  }
  const confirmedReentryPx =
    reentryConfirm.fillPrice > 0 ? reentryConfirm.fillPrice : fillPrice;
  await prisma.basket.create({
    data: {
      accountId,
      symbol,
      direction,
      filledLevel: 0,
      firstEntryPrice: confirmedReentryPx,
      status: "open",
      legs: { create: [{ level: 0, lots, price: confirmedReentryPx }] },
    },
  });
  await prisma.fill.create({
    data: {
      accountId,
      symbol,
      side: direction,
      lots,
      price: confirmedReentryPx,
      kind: "ENTRY",
      level: 0,
      note: `${logic}|${noteTag}|brokerTP=${reentryPx.takeProfit ?? "-"}|confirmed`,
    },
  });
  await refreshAndProtectBasket({
    metaId,
    symbol,
    direction,
    takeProfitPct: reentryTpPct,
    stopLossPct: reentrySlPct,
    stopLossEnabled,
    brokerLeverage,
  });
  return { ok: true };
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
  stopLossPct?: number;
  stopLossEnabled?: boolean;
  brokerLeverage?: number;
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
    stopLossPct,
    stopLossEnabled = true,
    brokerLeverage,
  } = opts;

  const closeRes = await closeSideFailClosed({
    metaId,
    symbol,
    direction,
    expectedPositions: opts.ourPositions.length,
  });
  if (!closeRes.ok) {
    return {
      closed: false as const,
      reentered: false as const,
      error: closeRes.message || `${symbol} 익절 청산 실패`,
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

  const re = await placeTpReentry({
    accountId,
    metaId,
    symbol,
    direction,
    logic,
    reentryLots,
    tpRoi,
    stopLossPct,
    stopLossEnabled,
    brokerLeverage,
    bid,
    ask,
    noteTag: "reentry_after_tp",
  });
  if (!re.ok) {
    return {
      closed: true as const,
      reentered: false as const,
      error: re.error,
    };
  }
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
  let direction = (cfg.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
  const logic = isTableLogic(cfg.logic) ? normalizeLogicId(cfg.logic) : "dubai_bruno_313";
  const timeLogic = isMartin9TimeLogic(logic);
  const h8Sk = timeLogic ? h8StateKey(accountId, symbol, logic) : "";
  let h8 = timeLogic ? h8SessionState.get(h8Sk) : undefined;

  // H8: lock session direction from barOpen; keep trading that side until next bar flatten.
  // Quiet window (open~+15m): no new ENTRY while flat (open books still managed below).
  if (timeLogic && h8) {
    if (h8.direction) direction = h8.direction;
    if (isInH8EntryQuiet() && (!h8.direction || !h8.entered)) {
      const hasBook =
        baskets.some(
          (b) => symbolsMatch(b.symbol, symbol) && b.legs.length > 0,
        ) || positions.some((p) => symbolsMatch(p.symbol, symbol));
      if (!hasBook) {
        return { ok: true as const, note: "h8_entry_quiet", symbol };
      }
    }
  }

  const resolved = await resolveStrategyForAccount(accountId, logic, {
    entryMultiplier: cfg.entryMultiplier,
    startLots: cfg.startLots,
  });
  const levels = resolved.levels;
  const startLots = resolved.startLots || cfg.startLots;
  // 회차 상한: entryCount 존중. 알파 지속(333)은 표 전체 강제(구 entryCount 314 캡 무시).
  const maxLevels = Math.max(
    1,
    Math.min(
      levels.length,
      isSustainedBulkLogic(logic)
        ? levels.length
        : cfg.entryCount > 0
          ? cfg.entryCount
          : levels.length,
    ),
  );
  const tag = logic.replace(/[^a-z0-9_]/gi, "").slice(0, 12) || "table";

  const levelLots = (levelIndex: number) => {
    // L0(첫 배팅)은 종목별 SymbolBot.startLots를 사용한다. 전략 오버라이드는
    // logicId 단위라 종목별로 다른 첫 배팅을 표현할 수 없으므로, 첫 회차만
    // 종목별 값으로 덮고 이후 물타기 회차는 표/오버라이드 로트를 따른다.
    if (levelIndex === 0 && cfg.startLots > 0) {
      return Math.max(0.01, Math.round(cfg.startLots * 100) / 100);
    }
    const levelIdx = Math.max(0, Math.min(levelIndex, levels.length - 1));
    const row = levels[levelIdx];
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
  // Resolve basket/positions before price hard-fail so open books stay manageable.
  let basket = baskets.find(
    (b) => symbolsMatch(b.symbol, symbol) && (b.direction === "SELL" ? "SELL" : "BUY") === direction,
  );
  // H8 time: DB/placeholder direction may differ — adopt any open book for symbol
  if (timeLogic && !basket) {
    basket = baskets.find((b) => symbolsMatch(b.symbol, symbol) && b.legs.length > 0);
    if (basket) {
      direction = (basket.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
      if (h8) {
        h8.direction = direction;
        h8.entered = true;
        await rememberH8State(accountId, symbol, logic, h8);
      }
    }
  }
  let ourPositions = positionsForSymbol(positions, symbol, direction);
  if (timeLogic && ourPositions.length === 0) {
    const anySide = positions.filter((p) => symbolsMatch(p.symbol, symbol));
    if (anySide.length > 0) {
      direction = anySide[0]!.direction;
      ourPositions = positionsForSymbol(positions, symbol, direction);
      if (h8) {
        h8.direction = direction;
        h8.entered = true;
        await rememberH8State(accountId, symbol, logic, h8);
      }
    }
  }

  if (!price || price.bid <= 0 || price.ask <= 0) {
    if (basket && basket.legs.length > 0 && ourPositions.length === 0) {
      return {
        ok: true as const,
        action: "ghost_pending",
        symbol,
        note: "await_ghost_heal_no_price",
      };
    }
    if (basket && basket.legs.length > 0) {
      return {
        ok: true as const,
        action: "hold",
        symbol,
        note: "await_price",
      };
    }
    return {
      ok: true as const,
      symbol,
      note: "no_price_skip_entry",
    };
  }

  const spr = spreadPct(price.bid, price.ask);
  // 양방향 운용: 같은 종목에 BUY/SELL 바스켓이 공존할 수 있으므로 방향으로 구분한다.

  // Ghost basket (DB open, MT5 empty): retry snapshot → 호가 긴급 TP/SL → 그래도 없으면 pending
  if (basket && basket.legs.length > 0 && ourPositions.length === 0) {
    const retry = await fetchSnapshot(metaId);
    if (retry.ok) {
      ourPositions = positionsForSymbol(retry.positions, symbol, direction);
    }
    if (ourPositions.length === 0) {
      const legsForGhost = basket.legs.sort((a, b) => a.level - b.level);
      const ghostTp = isBulkLogic(logic)
        ? levels[basket.filledLevel]?.profit && levels[basket.filledLevel]!.profit > 0
          ? levels[basket.filledLevel]!.profit
          : resolveLiveTakeProfitPct(logic, cfg.takeProfitPct)
        : resolveLiveTakeProfitPct(logic, cfg.takeProfitPct);
      const ghostExit = await tryGhostBasketSoftExit({
        accountId,
        metaId,
        symbol,
        direction,
        basket,
        legs: legsForGhost,
        bid: price.bid,
        ask: price.ask,
        logic,
        takeProfitPct: ghostTp,
        stopLossPct: resolveLiveStopLossPct(logic, cfg.stopLossPct),
        stopLossEnabled: cfg.stopLossEnabled,
        brokerLeverage: cfg.brokerLeverage,
        allowReentry: !cfg.manageOnly,
        repeatEnabled: cfg.repeatEnabled,
        reentryLots: levelLots(0),
      });
      if (ghostExit.handled) return ghostExit.result;
      return {
        ok: true as const,
        action: "ghost_pending",
        symbol,
        note: "await_ghost_heal",
      };
    }
  }

  if (!basket && ourPositions.length > 0) {
    const first = ourPositions[0];
    // Adopt as manageOnly L0-equivalent — do not assume N legs = filledLevel N-1
    // (manual extras would oversize next DCA).
    basket = await prisma.basket.create({
      data: {
        accountId,
        symbol,
        direction: first.direction,
        filledLevel: 0,
        tradingPaused: true,
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
    cfg = { ...cfg, manageOnly: true };
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
    // H8 time: after +15m with barOpen — lock direction once, then re-enter L0
    // on every flat until the next H8 bar flatten (sessionKey rollover).
    if (timeLogic) {
      h8 = h8SessionState.get(h8Sk);
      if (!h8) {
        return { ok: true as const, note: "h8_no_session_state", symbol };
      }
      if (isInH8EntryQuiet()) {
        return { ok: true as const, note: "h8_entry_quiet", symbol };
      }
      if (!canH8Enter() || h8.barOpen == null) {
        return { ok: true as const, note: "h8_wait_or_no_bar_open", symbol };
      }
      if (h8.direction === "BUY" || h8.direction === "SELL") {
        direction = h8.direction;
      } else {
        const mid = (price.bid + price.ask) / 2;
        const dir = h8DirectionFromOpen(mid, h8.barOpen);
        if (!dir) {
          return { ok: true as const, note: "h8_flat_no_direction", symbol };
        }
        direction = dir;
        h8.direction = dir;
        await rememberH8State(accountId, symbol, logic, h8);
      }
    }
    if (!(await canOpenNewRisk(accountId, symbol, direction))) {
      return { ok: true as const, note: "toggle_off_no_entry", symbol };
    }
    {
      const gate = await gateNewRiskOrder({
        accountId,
        metaId,
        symbol,
        direction,
        level: 0,
      });
      if (!gate.ok) {
        return { ok: true as const, note: gate.note, symbol };
      }
    }
    const lots = levelLots(0);
    const entryTpPct = isBulkLogic(logic)
      ? levels[0]?.profit && levels[0].profit > 0
        ? levels[0].profit
        : resolveLiveTakeProfitPct(logic, cfg.takeProfitPct)
      : resolveLiveTakeProfitPct(logic, cfg.takeProfitPct);
    const entrySlPct = resolveLiveStopLossPct(logic, cfg.stopLossPct);
    const fillPrice = mt5EntryQuote(direction, price.bid, price.ask);
    {
      const marginGate = await skipEntryIfMarginInsufficient({
        accountId,
        symbol,
        direction,
        lots,
        fillPrice,
        brokerLeverage: cfg.brokerLeverage,
      });
      if (marginGate.skip) {
        return { ok: true as const, note: marginGate.note, symbol };
      }
    }
    const entryLive = liveBasketTpSlUsd({
      symbol,
      lots,
      avgPrice: fillPrice,
      takeProfitPct: entryTpPct,
      stopLossPct: entrySlPct,
      brokerLeverage: cfg.brokerLeverage,
    });
    let stopsLevelPoints = 0;
    try {
      const spec = await getSymbolTradeSpec(metaId, symbol);
      stopsLevelPoints = spec.stopsLevel;
    } catch {
      /* ignore */
    }
    const entryPx = previewProtectPrices({
      symbol,
      direction,
      avgPrice: fillPrice,
      lots,
      takeProfitUsd: entryLive.takeProfitUsd,
      stopLossUsd: cfg.stopLossEnabled ? entryLive.stopLossUsd : 0,
      openPrices: [fillPrice],
      stopsLevelPoints,
    });
    let order = await placeMarketOrder({
      metaApiAccountId: metaId,
      symbol,
      direction,
      lots,
      comment: `SA-${tag}-L0`,
      takeProfit: entryPx.takeProfit,
      stopLoss: entryPx.stopLoss,
    });
    // 동봉 TP/SL 거절 시 나체 진입 — trade credit 소진이면 나체 재시도 금지
    if (
      !order.ok &&
      (entryPx.takeProfit != null || entryPx.stopLoss != null) &&
      !metaApiTradeCreditBlocked()
    ) {
      order = await placeMarketOrder({
        metaApiAccountId: metaId,
        symbol,
        direction,
        lots,
        comment: `SA-${tag}-L0`,
      });
    }
    if (!order.ok) {
      await noteOrderRejectIfSessionClosed({
        accountId,
        symbol,
        direction,
        message: order.message,
        kind: "entry",
      });
      return { ok: false as const, error: order.message, symbol };
    }
    const entryConfirm = await confirmLiveVolumeIncreased({
      metaId,
      symbol,
      direction,
      beforeLots: 0,
      expectedAdd: lots,
    });
    if (!entryConfirm.ok) {
      console.warn(
        `[engine] entry order ok but volume missing account=${accountId} ${symbol} ${direction} liveLots=${entryConfirm.afterLots}`,
      );
      // Stop trade-credit burn / tick spam when broker ACK without a live fill.
      await noteSessionTradeBackoff({
        accountId,
        symbol,
        direction,
        reason: "entry_ok_but_not_on_book",
        ms: 3 * 60_000,
      });
      return {
        ok: false as const,
        error: "entry_ok_but_not_on_book",
        symbol,
        spreadPct: spr,
      };
    }
    const confirmedEntryPrice =
      entryConfirm.fillPrice > 0 ? entryConfirm.fillPrice : fillPrice;
    await prisma.basket.create({
      data: {
        accountId,
        symbol,
        direction,
        filledLevel: 0,
        firstEntryPrice: confirmedEntryPrice,
        status: "open",
        legs: { create: [{ level: 0, lots, price: confirmedEntryPrice }] },
      },
    });
    await prisma.fill.create({
      data: {
        accountId,
        symbol,
        side: direction,
        lots,
        price: confirmedEntryPrice,
        kind: "ENTRY",
        level: 0,
        note: `${logic}|spr=${spr.toFixed(4)}|brokerTP=${entryPx.takeProfit ?? "-"}|confirmed`,
      },
    });
    const protectRes = await refreshAndProtectBasket({
      metaId,
      symbol,
      direction,
      takeProfitPct: entryTpPct,
      stopLossPct: entrySlPct,
      stopLossEnabled: cfg.stopLossEnabled,
      brokerLeverage: cfg.brokerLeverage,
    });
    if (timeLogic && h8Sk) {
      const st = h8SessionState.get(h8Sk);
      if (st) {
        st.entered = true;
        st.direction = direction;
        await rememberH8State(accountId, symbol, logic, st);
      }
    }
    if (!protectRes.ok && protectRes.reason !== "disabled") {
      return {
        ok: false as const,
        action: "entry_unprotected",
        symbol,
        error: `진입 후 브로커 TP/SL 동기화 실패: ${protectRes.reason}`,
        spreadPct: spr,
      };
    }
    return { ok: true as const, action: "entry", symbol, spreadPct: spr };
  }

  let legs = basket.legs.sort((a, b) => a.level - b.level);

  // 반대 방향 괴리: 브로커가 DB보다 많이 들고 있는 경우.
  // shouldSoftReconcileLegLag 는 dbLegCount <= livePosCount 에서 즉시 false 라
  // 이 방향은 재동기화도, 경고도 없었다. 2026-08-08 실계좌에서 DB 10.16 lots /
  // 브로커 31.28 lots 까지 벌어지도록 아무 신호가 없었다.
  //
  // 위로 재동기화하지 않는다: filledLevel 을 올리면 더 큰 물타기 회차가 풀려서
  // 오히려 위험하다. 여기서는 드러내기만 하고, 실제 차단은 아래 DCA 가드가 한다.
  if (ourPositions.length > legs.length && legs.length > 0) {
    const dbLots = legs.reduce((s, l) => s + l.lots, 0);
    const liveLots = ourPositions.reduce((s, p) => s + p.lots, 0);
    if (liveLots > dbLots + Math.max(0.02, dbLots * 0.1)) {
      console.error(
        `[engine] LOT DIVERGENCE account=${accountId} ${symbol} ${direction} dbLegs=${legs.length} live=${ourPositions.length} dbLots=${dbLots.toFixed(2)} liveLots=${liveLots.toFixed(2)} — broker ahead of DB, DCA blocked until resolved`,
      );
    }
  }

  // DB 레그 > 라이브 포지션: 스냅샷 지연일 수도, phantom DCA일 수도 있음.
  // 강제청산 금지. 볼륨이 크게 앞서면 live로 soft reconcile 후 계속.
  // 소폭 지연(방금 체결)이면 이번 틱 DCA만 막고 hold.
  if (ourPositions.length > 0 && legs.length > ourPositions.length) {
    const dbLots = legs.reduce((s, l) => s + l.lots, 0);
    const liveLots = ourPositions.reduce((s, p) => s + p.lots, 0);
    console.warn(
      `[engine] leg/pos lag account=${accountId} ${symbol} ${direction} dbLegs=${legs.length} live=${ourPositions.length} dbLots=${dbLots.toFixed(2)} liveLots=${liveLots.toFixed(2)}`,
    );
    // 방금 기록된 레그는 브로커 스냅샷에 아직 안 보일 수 있다 (rate-limit 등으로
    // stale). 그 상태로 reconcile 하면 방금 체결된 레벨이 지워지고, 다음 틱이
    // 같은 레벨을 재주문해 물량이 2배가 된다 — 2026-08-07 GBPUSD L3 중복 체결의
    // 실제 경로. 최신 레그가 3분 미만이면 reconcile 하지 않고 기다린다.
    const newestLeg = await prisma.basketLeg.findFirst({
      where: { basketId: basket.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const newestLegAgeMs = newestLeg
      ? Date.now() - new Date(newestLeg.createdAt).getTime()
      : Number.POSITIVE_INFINITY;
    const RECONCILE_LEG_GRACE_MS = 180_000;
    if (
      newestLegAgeMs >= RECONCILE_LEG_GRACE_MS &&
      shouldSoftReconcileLegLag({
        dbLegCount: legs.length,
        livePosCount: ourPositions.length,
        dbLots,
        liveLots,
      })
    ) {
      const planned = await softReconcileBasketLegsToLive({
        accountId,
        basketId: basket.id,
        symbol,
        direction,
        live: ourPositions.map((p) => ({
          lots: p.lots,
          price: p.price,
          profit: p.profit,
        })),
      });
      if (planned) {
        const basketId = basket!.id;
        basket = {
          ...basket!,
          filledLevel: planned.length - 1,
          legs: planned.map((l) => ({
            id: `reconciled-${l.level}`,
            basketId,
            level: l.level,
            lots: l.lots,
            price: l.price,
            createdAt: new Date(),
          })),
        };
        legs = basket.legs.sort((a, b) => a.level - b.level);
      }
    } else {
      await prisma.basket.update({
        where: { id: basket!.id },
        data: { unrealizedPnl: ourPositions.reduce((s, p) => s + p.profit, 0) },
      });
      return {
        ok: true as const,
        action: "hold",
        symbol,
        note: "leg_pos_lag_wait",
        filled: basket!.filledLevel,
        spreadPct: spr,
      };
    }
  }
  // MT5 실포지션 평단·손익 우선
  const posVol = ourPositions.reduce((s, p) => s + p.lots, 0);
  const avg =
    posVol > 0
      ? ourPositions.reduce((s, p) => s + p.lots * p.price, 0) / posVol
      : avgPrice(legs);
  const floatingPnl = ourPositions.reduce((s, p) => s + p.profit, 0);
  const profit = mt5ProfitPct(direction, avg, price.bid, price.ask);

  // 익절 ROI: 313차(bulk 표)는 현재 filledLevel 의 표 profit% (회차 티어).
  // 마틴9 계열은 resolveLiveTakeProfitPct → 프리셋 takeProfitPct (현재 10%).
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

  // 1차 방어: 브로커 지정가 TP/SL 동기화 (폴링 지연 대비)
  const protect = await syncBrokerBasketProtection({
    metaId,
    symbol,
    direction,
    positions: ourPositions,
    avgPrice: midRef,
    lots: lotsForTp,
    takeProfitUsd: liveUsd.takeProfitUsd,
    stopLossUsd: liveUsd.stopLossUsd,
    stopLossEnabled: cfg.stopLossEnabled,
  });
  if ((protect.failed ?? 0) > 0) {
    console.error(
      `[engine] broker protect partial fail account=${accountId} ${symbol} ${direction} failed=${protect.failed}`,
    );
  }

  const tpDecision = shouldTriggerTakeProfit({
    pnl: tpPnl.pnl,
    takeProfitUsd: liveUsd.takeProfitUsd,
    usedMargin,
    tpRoiPct: liveUsd.takeProfitPct,
  });
  // 익절 우선: BasketROI ≥ TP% → 바스켓 전량 청산 → 재진입
  // 폐장/세션 차단 시 시장가 청산 재시도 폭풍 방지 (브로커 TP가 1차 방어).
  if (tpDecision.hit) {
    const brokerTpMissing =
      (protect.failed ?? 0) > 0 ||
      !protect.targets?.takeProfit ||
      ourPositions.some(
        (p) =>
          !brokerProtectionMatches({
            current: p.takeProfit,
            target: protect.targets?.takeProfit,
            point: protect.targets?.point ?? 0.01,
          }),
      );
    return runSoftTpCloseAttempt({
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
      floatingRoi: tpDecision.floatingRoi,
      pnlSum: tpPnl.apiProfit,
      pnlForGuard: tpPnl.pnl,
      allowReentry: !cfg.manageOnly,
      stopLossPct: liveUsd.stopLossPct,
      stopLossEnabled: cfg.stopLossEnabled,
      brokerLeverage: brokerLev,
      brokerTpMissing,
      spr,
      profit,
      tpPnl,
    });
  }

  // 손절: BasketROI ≤ -SL% (마진 ROI, 바이낸스식) → 바스켓 전량 청산
  // pnlForSl = min(api,quote) — 손절 지연(익절용 max PnL) 방지
  const slDecision = shouldTriggerStopLossUsd({
    pnl: tpPnl.pnlForSl,
    stopLossUsd: cfg.stopLossEnabled ? liveUsd.stopLossUsd : 0,
    usedMargin: cfg.stopLossEnabled ? usedMargin : 0,
    stopLossRoiPct: cfg.stopLossEnabled ? liveUsd.stopLossPct : 0,
  });
  if (slDecision.hit) {
    const slAttempt = await runSoftSlCloseAttempt({
      accountId,
      metaId,
      symbol,
      direction,
    });
    if ("awaitSession" in slAttempt && slAttempt.awaitSession) {
      return {
        ok: true as const,
        action: "sl_await_session" as const,
        symbol,
        note: slAttempt.note,
        stopLossUsd: slDecision.stopLossUsd,
        floatingPnl: tpPnl.apiProfit,
        floatingRoi: slDecision.floatingRoi,
      };
    }
    if (!slAttempt.ok) {
      return {
        ok: false as const,
        error: slAttempt.message,
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
        note: `${logic}|roi=${slDecision.floatingRoi.toFixed(2)}%<=-${liveUsd.stopLossPct}%|pnl=${pnlSum.toFixed(2)}<=-sl$${slDecision.stopLossUsd}|pnlForSl=${tpPnl.pnlForSl.toFixed(2)}`,
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
      floatingRoi: slDecision.floatingRoi,
      stopLossUsd: slDecision.stopLossUsd,
      spreadPct: spr,
    };
  }

  // 물타기: 순수 바스켓 마진 ROI ≤ -표 drop% (가격 로직 없음). drop 은 20/40/…/350.
  // 한 틱(평가)당 최대 1회차만 추가 → 다음 틱에서 avg/margin/ROI 재계산 (바이낸스 안전주문식).
  // manageOnly / 토글 OFF 시 물타기 금지 (열린 바스켓은 익절·손절만).
  // H8 quiet (open~+15m): no DCA for time logics either.
  if (cfg.manageOnly || (timeLogic && isInH8EntryQuiet())) {
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

    // Fail-closed: refuse to add risk while the broker holds more than the
    // ladder accounts for.
    //
    // When confirmLiveVolumeIncreased() times out, the DCA leg is never written
    // and basket.filledLevel stays put — but the order can still land at the
    // broker moments later. The next tick then re-orders the same level, and the
    // position silently doubles. Observed 2026-08-08 on a live GBPUSD basket:
    // DB said 10.16 lots, the broker held 31.28.
    {
      let ladderLots = 0;
      for (let i = 0; i <= filled; i++) ladderLots += levelLots(i);
      if (shouldBlockDcaForLotDivergence({ ladderLots, brokerLots: posVol })) {
        console.error(
          `[engine] DCA BLOCKED account=${accountId} ${symbol} ${direction} L${next} — broker=${posVol.toFixed(2)} lots > ladder=${ladderLots.toFixed(2)} (filledLevel=${filled}). Lot divergence; refusing to add.`,
        );
        return {
          ok: true as const,
          action: "hold",
          symbol,
          note: `dca_blocked_lot_divergence broker=${posVol.toFixed(2)} ladder=${ladderLots.toFixed(2)}`,
          filled,
          actions,
          spreadPct: spr,
        };
      }
    }

    const estFill = mt5EntryQuote(direction, price.bid, price.ask);
    const projLots = posVol + lots;
    const projAvg =
      projLots > 0 ? (posVol * avg + lots * estFill) / projLots : estFill;
    const dcaTpPct = isBulkLogic(logic)
      ? levels[next]?.profit && levels[next]!.profit > 0
        ? levels[next]!.profit
        : tpRoiFallback
      : tpRoiFallback;
    const projLive = liveBasketTpSlUsd({
      symbol,
      lots: projLots,
      avgPrice: projAvg,
      takeProfitPct: dcaTpPct,
      stopLossPct: slRoiFallback,
      brokerLeverage: brokerLev,
      brokerMarginSum: brokerMarginSum > 0 ? brokerMarginSum : null,
    });
    let stopsLevelPoints = 0;
    try {
      stopsLevelPoints = (await getSymbolTradeSpec(metaId, symbol)).stopsLevel;
    } catch {
      /* ignore */
    }
    const projPx = previewProtectPrices({
      symbol,
      direction,
      avgPrice: projAvg,
      lots: projLots,
      takeProfitUsd: projLive.takeProfitUsd,
      stopLossUsd: cfg.stopLossEnabled ? projLive.stopLossUsd : 0,
      openPrices: [...ourPositions.map((p) => p.price), estFill],
      stopsLevelPoints,
    });
    // DCA 전: 기존 레그 SL/TP를 새 바스켓 기준으로 먼저 재설정 (조기 손절 방지)
    await syncBrokerBasketProtection({
      metaId,
      symbol,
      direction,
      positions: ourPositions,
      avgPrice: projAvg,
      lots: projLots,
      takeProfitUsd: projLive.takeProfitUsd,
      stopLossUsd: projLive.stopLossUsd,
      stopLossEnabled: cfg.stopLossEnabled,
    });

    {
      const gate = await gateNewRiskOrder({
        accountId,
        metaId,
        symbol,
        direction,
        level: next,
        livePositions: ourPositions,
      });
      if (!gate.ok) {
        return {
          ok: true as const,
          action: "hold",
          symbol,
          note: gate.note,
          filled,
          actions,
          spreadPct: spr,
        };
      }
    }
    {
      const marginGate = await skipEntryIfMarginInsufficient({
        accountId,
        symbol,
        direction,
        lots,
        fillPrice: estFill,
        brokerLeverage: cfg.brokerLeverage,
      });
      if (marginGate.skip) {
        return {
          ok: true as const,
          action: "hold",
          symbol,
          note: marginGate.note,
          filled,
          actions,
          spreadPct: spr,
        };
      }
    }
    let order = await placeMarketOrder({
      metaApiAccountId: metaId,
      symbol,
      direction,
      lots,
      comment: `SA-${tag}-L${next}`,
      takeProfit: projPx.takeProfit,
      stopLoss: projPx.stopLoss,
    });
    if (
      !order.ok &&
      (projPx.takeProfit != null || projPx.stopLoss != null) &&
      !metaApiTradeCreditBlocked()
    ) {
      order = await placeMarketOrder({
        metaApiAccountId: metaId,
        symbol,
        direction,
        lots,
        comment: `SA-${tag}-L${next}`,
      });
    }
    if (!order.ok) {
      await noteOrderRejectIfSessionClosed({
        accountId,
        symbol,
        direction,
        message: order.message,
        kind: "dca",
      });
      return {
        ok: false as const,
        error: order.message,
        symbol,
        filled,
        actions,
        spreadPct: spr,
      };
    }
    const dcaConfirm = await confirmLiveVolumeIncreased({
      metaId,
      symbol,
      direction,
      beforeLots: posVol,
      expectedAdd: lots,
    });
    if (!dcaConfirm.ok) {
      console.error(
        `[engine] ORPHAN FILL RISK: dca order ok but volume missing account=${accountId} ${symbol} L${next} before=${posVol} after=${dcaConfirm.afterLots} — 레그 미기록. 늦게 체결되면 DB/브로커 물량이 어긋난다.`,
      );
      return {
        ok: false as const,
        error: "dca_ok_but_not_on_book",
        symbol,
        filled,
        actions,
        spreadPct: spr,
      };
    }
    const fillPrice =
      dcaConfirm.fillPrice > 0
        ? dcaConfirm.fillPrice
        : mt5EntryQuote(direction, price.bid, price.ask);
    // 의도한 lots 가 아니라 브로커에서 실제로 늘어난 물량을 기록한다.
    // 주문이 중복 발행되면(스트림 타임아웃 후 REST 재발행 등) 실제 증가분이
    // 더 크다. 의도값만 적으면 그 차이가 영구 괴리로 남는다.
    const recordedLots =
      dcaConfirm.addedLots > lots + 1e-9
        ? Math.round(dcaConfirm.addedLots * 100) / 100
        : lots;
    const overFillNote = recordedLots > lots + 1e-9 ? `|OVERFILL=${recordedLots}` : "";
    await prisma.basketLeg.create({
      data: { basketId: basket.id, level: next, lots: recordedLots, price: fillPrice },
    });
    await prisma.fill.create({
      data: {
        accountId,
        symbol,
        side: direction,
        lots: recordedLots,
        price: fillPrice,
        kind: "DCA",
        level: next,
        note: `${logic}|dcaROI=${dcaHit.basketRoi.toFixed(2)}%<=-${dropRoi}%|margin$${usedMargin.toFixed(2)}|confirmed${overFillNote}`,
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
    const dcaTp = isBulkLogic(logic)
      ? levels[filled]?.profit && levels[filled].profit > 0
        ? levels[filled].profit
        : tpRoiFallback
      : tpRoiFallback;
    const protectRes = await refreshAndProtectBasket({
      metaId,
      symbol,
      direction,
      takeProfitPct: dcaTp,
      stopLossPct: slRoiFallback,
      stopLossEnabled: cfg.stopLossEnabled,
      brokerLeverage: brokerLev,
    });
    if (!protectRes.ok && protectRes.reason !== "disabled") {
      return {
        ok: false as const,
        action: "dca_unprotected",
        symbol,
        filled,
        actions,
        error: `DCA 후 브로커 TP/SL 동기화 실패: ${protectRes.reason}`,
        spreadPct: spr,
      };
    }
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
  let basket = baskets.find(
    (b) => symbolsMatch(b.symbol, symbol) && (b.direction === "SELL" ? "SELL" : "BUY") === direction,
  );
  let ourPositions = positionsForSymbol(positions, symbol, direction);

  if (!price || price.bid <= 0) {
    if (basket && basket.legs.length > 0 && ourPositions.length === 0) {
      return {
        ok: true as const,
        action: "ghost_pending",
        symbol,
        note: "await_ghost_heal_no_price",
      };
    }
    if (basket && basket.legs.length > 0) {
      return {
        ok: true as const,
        action: "hold",
        symbol,
        note: "await_price",
      };
    }
    return {
      ok: true as const,
      symbol,
      note: "no_price_skip_entry",
    };
  }

  // Same as table-logic path: retry → ghost soft TP/SL → pending
  if (basket && basket.legs.length > 0 && ourPositions.length === 0) {
    const retry = await fetchSnapshot(metaId);
    if (retry.ok) {
      ourPositions = positionsForSymbol(retry.positions, symbol, direction);
    }
    if (ourPositions.length === 0) {
      const legsForGhost = basket.legs.sort((a, b) => a.level - b.level);
      const ghostExit = await tryGhostBasketSoftExit({
        accountId,
        metaId,
        symbol,
        direction,
        basket,
        legs: legsForGhost,
        bid: price.bid,
        ask: price.ask,
        logic,
        takeProfitPct: resolveLiveTakeProfitPct(logic, cfg.takeProfitPct),
        stopLossPct: resolveLiveStopLossPct(logic, cfg.stopLossPct),
        stopLossEnabled: cfg.stopLossEnabled,
        brokerLeverage: cfg.brokerLeverage,
        allowReentry: !cfg.manageOnly,
        repeatEnabled: cfg.repeatEnabled,
        reentryLots: lotsAtLevel(cfg.startLots, cfg.entryMultiplier, 0, logic),
      });
      if (ghostExit.handled) return ghostExit.result;
      return {
        ok: true as const,
        action: "ghost_pending",
        symbol,
        note: "await_ghost_heal",
      };
    }
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
    {
      const gate = await gateNewRiskOrder({
        accountId,
        metaId,
        symbol,
        direction,
        level: 0,
      });
      if (!gate.ok) {
        return { ok: true as const, note: gate.note, symbol };
      }
    }
    const lots = lotsAtLevel(cfg.startLots, cfg.entryMultiplier, 0, logic);
    const entryTpPct = resolveLiveTakeProfitPct(logic, cfg.takeProfitPct);
    const entrySlPct = resolveLiveStopLossPct(logic, cfg.stopLossPct);
    const fillPrice = mt5EntryQuote(direction, price.bid, price.ask);
    {
      const marginGate = await skipEntryIfMarginInsufficient({
        accountId,
        symbol,
        direction,
        lots,
        fillPrice,
        brokerLeverage: cfg.brokerLeverage,
      });
      if (marginGate.skip) {
        return { ok: true as const, note: marginGate.note, symbol };
      }
    }
    const entryLive = liveBasketTpSlUsd({
      symbol,
      lots,
      avgPrice: fillPrice,
      takeProfitPct: entryTpPct,
      stopLossPct: entrySlPct,
      brokerLeverage: cfg.brokerLeverage,
    });
    let stopsLevelPoints = 0;
    try {
      stopsLevelPoints = (await getSymbolTradeSpec(metaId, symbol)).stopsLevel;
    } catch {
      /* ignore */
    }
    const entryPx = previewProtectPrices({
      symbol,
      direction,
      avgPrice: fillPrice,
      lots,
      takeProfitUsd: entryLive.takeProfitUsd,
      stopLossUsd: cfg.stopLossEnabled ? entryLive.stopLossUsd : 0,
      openPrices: [fillPrice],
      stopsLevelPoints,
    });
    let order = await placeMarketOrder({
      metaApiAccountId: metaId,
      symbol,
      direction,
      lots,
      comment: `SA-${logic}-L0`,
      takeProfit: entryPx.takeProfit,
      stopLoss: entryPx.stopLoss,
    });
    if (
      !order.ok &&
      (entryPx.takeProfit != null || entryPx.stopLoss != null) &&
      !metaApiTradeCreditBlocked()
    ) {
      order = await placeMarketOrder({
        metaApiAccountId: metaId,
        symbol,
        direction,
        lots,
        comment: `SA-${logic}-L0`,
      });
    }
    if (!order.ok) {
      await noteOrderRejectIfSessionClosed({
        accountId,
        symbol,
        direction,
        message: order.message,
        kind: "entry",
      });
      return { ok: false as const, error: order.message, symbol };
    }
    const entryConfirm2 = await confirmLiveVolumeIncreased({
      metaId,
      symbol,
      direction,
      beforeLots: 0,
      expectedAdd: lots,
    });
    if (!entryConfirm2.ok) {
      console.warn(
        `[engine] entry order ok but volume missing account=${accountId} ${symbol} liveLots=${entryConfirm2.afterLots}`,
      );
      await noteSessionTradeBackoff({
        accountId,
        symbol,
        direction,
        reason: "entry_ok_but_not_on_book",
        ms: 3 * 60_000,
      });
      return { ok: false as const, error: "entry_ok_but_not_on_book", symbol };
    }
    const confirmedPx2 =
      entryConfirm2.fillPrice > 0 ? entryConfirm2.fillPrice : fillPrice;
    await prisma.basket.create({
      data: {
        accountId,
        symbol,
        direction,
        filledLevel: 0,
        firstEntryPrice: confirmedPx2,
        status: "open",
        legs: { create: [{ level: 0, lots, price: confirmedPx2 }] },
      },
    });
    await prisma.fill.create({
      data: {
        accountId,
        symbol,
        side: direction,
        lots,
        price: confirmedPx2,
        kind: "ENTRY",
        level: 0,
        note: `${logic}|confirmed`,
      },
    });
    const protectRes = await refreshAndProtectBasket({
      metaId,
      symbol,
      direction,
      takeProfitPct: entryTpPct,
      stopLossPct: entrySlPct,
      stopLossEnabled: cfg.stopLossEnabled,
      brokerLeverage: cfg.brokerLeverage,
    });
    if (!protectRes.ok && protectRes.reason !== "disabled") {
      return {
        ok: false as const,
        action: "entry_unprotected",
        symbol,
        error: `진입 후 브로커 TP/SL 동기화 실패: ${protectRes.reason}`,
      };
    }
    return { ok: true as const, action: "entry", symbol };
  }

  let legs = basket.legs.sort((a, b) => a.level - b.level);
  if (ourPositions.length > 0 && legs.length > ourPositions.length) {
    const dbLots = legs.reduce((s, l) => s + l.lots, 0);
    const liveLotsNow = ourPositions.reduce((s, p) => s + p.lots, 0);
    console.warn(
      `[engine] leg/pos lag account=${accountId} ${symbol} ${direction} dbLegs=${legs.length} live=${ourPositions.length} dbLots=${dbLots.toFixed(2)} liveLots=${liveLotsNow.toFixed(2)}`,
    );
    if (
      shouldSoftReconcileLegLag({
        dbLegCount: legs.length,
        livePosCount: ourPositions.length,
        dbLots,
        liveLots: liveLotsNow,
      })
    ) {
      const planned = await softReconcileBasketLegsToLive({
        accountId,
        basketId: basket.id,
        symbol,
        direction,
        live: ourPositions.map((p) => ({
          lots: p.lots,
          price: p.price,
          profit: p.profit,
        })),
      });
      if (planned) {
        const basketId = basket!.id;
        basket = {
          ...basket!,
          filledLevel: planned.length - 1,
          legs: planned.map((l) => ({
            id: `reconciled-${l.level}`,
            basketId,
            level: l.level,
            lots: l.lots,
            price: l.price,
            createdAt: new Date(),
          })),
        };
        legs = basket.legs.sort((a, b) => a.level - b.level);
      }
    } else {
      return {
        ok: true as const,
        action: "hold",
        symbol,
        note: "leg_pos_lag_wait",
      };
    }
  }
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

  const protect = await syncBrokerBasketProtection({
    metaId,
    symbol,
    direction,
    positions: ourPositions,
    avgPrice: midRef,
    lots: lotsForTp,
    takeProfitUsd: liveUsd.takeProfitUsd,
    stopLossUsd: liveUsd.stopLossUsd,
    stopLossEnabled: cfg.stopLossEnabled,
  });
  if ((protect.failed ?? 0) > 0) {
    console.error(
      `[engine] broker protect partial fail account=${accountId} ${symbol} ${direction} failed=${protect.failed}`,
    );
  }

  const tpDecision = shouldTriggerTakeProfit({
    pnl: tpPnl.pnl,
    takeProfitUsd: liveUsd.takeProfitUsd,
    usedMargin,
    tpRoiPct: liveUsd.takeProfitPct,
  });

  if (tpDecision.hit) {
    const brokerTpMissing =
      (protect.failed ?? 0) > 0 ||
      !protect.targets?.takeProfit ||
      ourPositions.some(
        (p) =>
          !brokerProtectionMatches({
            current: p.takeProfit,
            target: protect.targets?.takeProfit,
            point: protect.targets?.point ?? 0.01,
          }),
      );
    return runSoftTpCloseAttempt({
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
      floatingRoi: tpDecision.floatingRoi,
      pnlSum: tpPnl.apiProfit,
      pnlForGuard: tpPnl.pnl,
      allowReentry: !cfg.manageOnly,
      stopLossPct: liveUsd.stopLossPct,
      stopLossEnabled: cfg.stopLossEnabled,
      brokerLeverage: brokerLev,
      brokerTpMissing,
      tpPnl,
    });
  }

  const slDecision = shouldTriggerStopLossUsd({
    pnl: tpPnl.pnlForSl,
    stopLossUsd: cfg.stopLossEnabled ? liveUsd.stopLossUsd : 0,
    usedMargin: cfg.stopLossEnabled ? usedMargin : 0,
    stopLossRoiPct: cfg.stopLossEnabled ? liveUsd.stopLossPct : 0,
  });
  if (slDecision.hit) {
    const slAttempt = await runSoftSlCloseAttempt({
      accountId,
      metaId,
      symbol,
      direction,
    });
    if ("awaitSession" in slAttempt && slAttempt.awaitSession) {
      return {
        ok: true as const,
        action: "sl_await_session" as const,
        symbol,
        note: slAttempt.note,
        stopLossUsd: slDecision.stopLossUsd,
        floatingPnl: tpPnl.apiProfit,
        floatingRoi: slDecision.floatingRoi,
      };
    }
    if (!slAttempt.ok) {
      return {
        ok: false as const,
        error: slAttempt.message,
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
        note: `${logic}|roi=${slDecision.floatingRoi.toFixed(2)}%<=-${liveUsd.stopLossPct}%|pnl=${tpPnl.apiProfit.toFixed(2)}<=-sl$${slDecision.stopLossUsd}|pnlForSl=${tpPnl.pnlForSl.toFixed(2)}`,
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
      floatingRoi: slDecision.floatingRoi,
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

    // Same fail-closed lot-divergence guard as the ladder path above: never add
    // risk while the broker already holds more than the ladder accounts for.
    {
      let ladderLots = 0;
      for (let i = 0; i <= basket.filledLevel; i++) {
        ladderLots += lotsAtLevel(cfg.startLots, cfg.entryMultiplier, i, logic);
      }
      if (shouldBlockDcaForLotDivergence({ ladderLots, brokerLots: posVol })) {
        console.error(
          `[engine] DCA BLOCKED account=${accountId} ${symbol} ${direction} L${nextLevel} — broker=${posVol.toFixed(2)} lots > ladder=${ladderLots.toFixed(2)} (filledLevel=${basket.filledLevel}). Lot divergence; refusing to add.`,
        );
        return {
          ok: true as const,
          action: "hold",
          symbol,
          note: `dca_blocked_lot_divergence broker=${posVol.toFixed(2)} ladder=${ladderLots.toFixed(2)}`,
        };
      }
    }

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
      {
        const gate = await gateNewRiskOrder({
          accountId,
          metaId,
          symbol,
          direction,
          level: nextLevel,
          livePositions: ourPositions,
        });
        if (!gate.ok) {
          return {
            ok: true as const,
            action: "hold",
            symbol,
            note: gate.note,
            profit,
            floatingRoi,
            tpMoney: liveUsd.takeProfitUsd,
            stopLossUsd: liveUsd.stopLossUsd,
          };
        }
      }
      const estFill = mt5EntryQuote(direction, price.bid, price.ask);
      const projLots = posVol + lots;
      const projAvg =
        projLots > 0
          ? (ourPositions.reduce((s, p) => s + p.lots * p.price, 0) + lots * estFill) /
            projLots
          : estFill;
      const dcaTpPct = resolveLiveTakeProfitPct(logic, cfg.takeProfitPct);
      const dcaSlPct = resolveLiveStopLossPct(logic, cfg.stopLossPct);
      const projLive = liveBasketTpSlUsd({
        symbol,
        lots: projLots,
        avgPrice: projAvg,
        takeProfitPct: dcaTpPct,
        stopLossPct: dcaSlPct,
        brokerLeverage: brokerLev,
        brokerMarginSum: null,
      });
      let stopsLevelPoints = 0;
      try {
        stopsLevelPoints = (await getSymbolTradeSpec(metaId, symbol)).stopsLevel;
      } catch {
        /* ignore */
      }
      const projPx = previewProtectPrices({
        symbol,
        direction,
        avgPrice: projAvg,
        lots: projLots,
        takeProfitUsd: projLive.takeProfitUsd,
        stopLossUsd: cfg.stopLossEnabled ? projLive.stopLossUsd : 0,
        openPrices: [...ourPositions.map((p) => p.price), estFill],
        stopsLevelPoints,
      });
      await syncBrokerBasketProtection({
        metaId,
        symbol,
        direction,
        positions: ourPositions,
        avgPrice: projAvg,
        lots: projLots,
        takeProfitUsd: projLive.takeProfitUsd,
        stopLossUsd: projLive.stopLossUsd,
        stopLossEnabled: cfg.stopLossEnabled,
      });
      {
        const marginGate = await skipEntryIfMarginInsufficient({
          accountId,
          symbol,
          direction,
          lots,
          fillPrice: estFill,
          brokerLeverage: cfg.brokerLeverage,
        });
        if (marginGate.skip) {
          return {
            ok: true as const,
            action: "hold",
            symbol,
            note: marginGate.note,
            profit,
            floatingRoi,
            tpMoney: liveUsd.takeProfitUsd,
            stopLossUsd: liveUsd.stopLossUsd,
          };
        }
      }
      let order = await placeMarketOrder({
        metaApiAccountId: metaId,
        symbol,
        direction,
        lots,
        comment: `SA-${logic}-L${nextLevel}`,
        takeProfit: projPx.takeProfit,
        stopLoss: projPx.stopLoss,
      });
      if (
        !order.ok &&
        (projPx.takeProfit != null || projPx.stopLoss != null) &&
        !metaApiTradeCreditBlocked()
      ) {
        order = await placeMarketOrder({
          metaApiAccountId: metaId,
          symbol,
          direction,
          lots,
          comment: `SA-${logic}-L${nextLevel}`,
        });
      }
      if (!order.ok) {
        await noteOrderRejectIfSessionClosed({
          accountId,
          symbol,
          direction,
          message: order.message,
          kind: "dca",
        });
        return { ok: false as const, error: order.message, symbol };
      }
      const dcaConfirm = await confirmLiveVolumeIncreased({
        metaId,
        symbol,
        direction,
        beforeLots: ourPositions.reduce((s, p) => s + p.lots, 0),
        expectedAdd: lots,
      });
      if (!dcaConfirm.ok) {
        console.error(
          `[engine] ORPHAN FILL RISK: dca order ok but volume missing account=${accountId} ${symbol} L${nextLevel} after=${dcaConfirm.afterLots} — 레그 미기록. 늦게 체결되면 DB/브로커 물량이 어긋난다.`,
        );
        return { ok: false as const, error: "dca_ok_but_not_on_book", symbol };
      }
      const fillPrice =
        dcaConfirm.fillPrice > 0 ? dcaConfirm.fillPrice : estFill;
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
          note: `${logic}|dcaROI=${dcaHit.basketRoi.toFixed(2)}%<=-${needRoi}%|margin$${usedMargin.toFixed(2)}|confirmed`,
        },
      });
      const protectRes = await refreshAndProtectBasket({
        metaId,
        symbol,
        direction,
        takeProfitPct: dcaTpPct,
        stopLossPct: dcaSlPct,
        stopLossEnabled: cfg.stopLossEnabled,
        brokerLeverage: brokerLev,
      });
      if (!protectRes.ok && protectRes.reason !== "disabled") {
        return {
          ok: false as const,
          action: "dca_unprotected",
          symbol,
          level: nextLevel,
          error: `DCA 후 브로커 TP/SL 동기화 실패: ${protectRes.reason}`,
        };
      }
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

// Must exceed ENGINE_CLOUD_WAIT_MS (~45s) so a second worker cannot steal the lock mid-tick.
const TICK_LOCK_STALE_MS = Math.max(
  90_000,
  Number(process.env.ENGINE_TICK_LOCK_STALE_MS || 180_000),
);

/** In-process + DB mutex so local engine / GHA / serverless don't double-trade. */
/** 이 프로세스가 락을 잡을 때 심은 타임스탬프 — 해제 시 소유권 확인에 쓴다. */
const tickLockStamps = new Map<string, Date>();

async function tryAcquireTickLock(accountId: string): Promise<boolean> {
  if (tickLocks.has(accountId)) return false;
  const staleBefore = new Date(Date.now() - TICK_LOCK_STALE_MS);
  // NOW() 대신 클라이언트 시각을 심는다. staleBefore 도 클라이언트 시각이라
  // 둘을 같은 시계로 맞춰야 하고, 해제 시 "내가 심은 값인지" 대조할 수 있다.
  const stamp = new Date();
  try {
    const grabbed = await prisma.$executeRaw`
      UPDATE "BrokerAccount"
      SET "tickLockedAt" = ${stamp}
      WHERE "id" = ${accountId}
        AND ("tickLockedAt" IS NULL OR "tickLockedAt" < ${staleBefore})
    `;
    if (Number(grabbed) < 1) return false;
  } catch (e) {
    // Fail-closed. 예전에는 여기서 예외를 삼키고 return true 로 흘러가
    // DB 장애 한 번에 여러 인스턴스가 동시에 같은 계좌를 틱할 수 있었다.
    // 락을 확인 못 하면 틱하지 않는다 — 이중 주문보다 한 틱 거르는 게 낫다.
    console.error(
      `[engine] tick lock 획득 실패(DB) account=${accountId} — 이번 틱 건너뜀:`,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
  tickLockStamps.set(accountId, stamp);
  tickLocks.add(accountId);
  return true;
}

async function releaseTickLock(accountId: string) {
  tickLocks.delete(accountId);
  const stamp = tickLockStamps.get(accountId);
  tickLockStamps.delete(accountId);
  // 내가 심은 타임스탬프일 때만 지운다. 조건 없이 지우면, 내 틱이 늘어져
  // 다른 인스턴스가 stale 판정으로 락을 가져간 뒤 내가 그 락을 풀어버린다.
  if (!stamp) return;
  try {
    await prisma.brokerAccount.updateMany({
      where: { id: accountId, tickLockedAt: stamp },
      data: { tickLockedAt: null },
    });
  } catch {
    /* ignore */
  }
}

export type RunDcaTickOpts = {
  /** Backup ticks: open baskets only, never ENTRY/DCA. */
  forceManageOnly?: boolean;
};

export async function runDcaTick(accountId: string, opts?: RunDcaTickOpts) {
  const got = await tryAcquireTickLock(accountId);
  if (!got) {
    return { skipped: true as const, reason: "busy" };
  }
  try {
    return await runDcaTickInner(accountId, opts);
  } finally {
    await releaseTickLock(accountId);
  }
}

async function runDcaTickInner(accountId: string, opts?: RunDcaTickOpts) {
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

  // Soft DB region hint only (may be stale). Live MetaAPI region wins via resolve TTL /
  // and on snap network fail we refresh+retry below.
  if (account.metaApiRegion) {
    primeMetaRegionCache(account.metaApiAccountId, account.metaApiRegion);
  }

  const masterOn = !!account.botEnabled;
  const hasOpenBaskets = account.baskets.length > 0;
  // 전체 OFF + 열린 포지션 없음 → 틱 스킵
  if (!masterOn && !hasOpenBaskets) {
    return { skipped: true as const, reason: "bot_off" };
  }
  // 폐장 + 평탄: MetaAPI 스냅 자체 생략
  if (isFxMarketClosed() && !hasOpenBaskets) {
    return { skipped: true as const, reason: "fx_market_closed" };
  }
  // Bot ON + cloud cold: recover here too (not only in runAllBots).
  // Previously status==="undeployed" skipped the whole tick → trading looked "stopped".
  if (account.status !== "connected" && account.status !== "undeployed") {
    return { skipped: true as const, reason: "not_connected" };
  }

  const metaId = account.metaApiAccountId;
  // 폐장+열린바스켓: 감시만 느리게 (브로커 TP/SL 유지). 장중은 정상 주기.
  const snapStaleMs = isFxMarketClosed()
    ? Math.max(60_000, Number(process.env.ENGINE_SNAP_STALE_CLOSED_MS || 120_000))
    : Math.max(8_000, Number(process.env.ENGINE_SNAP_STALE_MS || 15_000));
  let snap = await fetchSnapshot(metaId, { allowStaleMs: snapStaleMs });
  // REST 429 / cold stream: force stream attach then retry — trading must continue.
  if (
    !snap.ok &&
    (snap.code === "RATE_LIMIT" ||
      /요청 한도|TooManyRequests|rate limit/i.test(snap.message || ""))
  ) {
    try {
      const { ensureStreamConnected } = await import("./metaapi-stream");
      await ensureStreamConnected(metaId, account.metaApiRegion);
      snap = await fetchSnapshot(metaId, { allowStaleMs: snapStaleMs });
    } catch {
      /* keep snap */
    }
  }
  // Wrong cached/DB region can timeout; refresh+retry once.
  // Skip fan-out retry on RATE_LIMIT (would burn more credits).
  if (
    !snap.ok &&
    snap.code !== "RATE_LIMIT" &&
    /네트워크|network|timeout|econnreset|fetch failed|unstable/i.test(snap.message || "")
  ) {
    try {
      const liveRegion = await refreshAccountRegion(metaId);
      if (liveRegion && liveRegion !== (account.metaApiRegion || "").toLowerCase()) {
        await prisma.brokerAccount.update({
          where: { id: account.id },
          data: { metaApiRegion: liveRegion },
        });
        account.metaApiRegion = liveRegion;
      }
      snap = await fetchSnapshot(metaId);
    } catch {
      clearMetaRegionCache(metaId);
    }
  }
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
        allowRecreate: false,
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
    const cold = isCloudColdError(snap.message || "");
    const rateLimited =
      snap.code === "RATE_LIMIT" || /요청 한도|TooManyRequests|rate limit/i.test(snap.message || "");
    const transientNet =
      !rateLimited &&
      /네트워크|network|timeout|econnreset|fetch failed|unstable/i.test(
        snap.message || "",
      );
    // Never show 429 / network / retry copy to members — bot + broker TP/SL stay on.
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        statusMessage: masterOn
          ? "클라우드 연결 · 봇 실행 중"
          : "봇 중지 · 열린 포지션 익절·손절만 관리",
        ...(cold && !transientNet && !rateLimited ? { status: "undeployed" } : {}),
        ...(masterOn ? { botEnabled: true, botStoppedAt: null } : {}),
      },
    });
    return { ok: false as const, error: snap.message };
  }

  // Open-burst flatten: once per KST window when user chose "flatten"
  {
    const burst = await loadOpenBurstSettings(account.id);
    const quiet = isInOpenBurstQuietPeriod();
    if (!quiet.active && burst.openBurstLastFlattenLabel) {
      await saveOpenBurstSettings(account.id, { openBurstLastFlattenLabel: null });
    } else if (
      masterOn &&
      burst.skipOpenBurstEntries &&
      burst.openBurstOnTrigger === "flatten" &&
      quiet.active &&
      quiet.label &&
      burst.openBurstLastFlattenLabel !== quiet.label
    ) {
      if (snap.positions.length > 0) {
        console.warn(
          `[engine] open-burst flatten account=${account.id} window=${quiet.label} pos=${snap.positions.length}`,
        );
        const closed = await closeAllPositions(metaId);
        if (!closed.ok) {
          console.error(
            `[engine] open-burst flatten incomplete account=${account.id}: ${closed.message}`,
          );
          // Do not stamp label — retry next tick
        } else {
          await prisma.basket.updateMany({
            where: { accountId: account.id, status: "open" },
            data: {
              status: "closed",
              lastExitAt: new Date(),
              unrealizedPnl: 0,
            },
          });
          await prisma.fill.create({
            data: {
              accountId: account.id,
              symbol: "ALL",
              side: "SELL",
              lots: 0,
              price: 0,
              pnl: 0,
              kind: "GUARD",
              note: `open_burst_flatten|${quiet.label}|closed=${closed.closed ?? 0}`,
            },
          });
          await saveOpenBurstSettings(account.id, {
            openBurstLastFlattenLabel: quiet.label,
          });
          const again = await fetchSnapshot(metaId, { allowStaleMs: 0 });
          if (again.ok) snap = again;
          account.baskets.splice(0, account.baskets.length);
        }
      } else {
        await saveOpenBurstSettings(account.id, {
          openBurstLastFlattenLabel: quiet.label,
        });
        if (account.baskets.length > 0) {
          await prisma.basket.updateMany({
            where: { accountId: account.id, status: "open" },
            data: {
              status: "closed",
              lastExitAt: new Date(),
              unrealizedPnl: 0,
            },
          });
          account.baskets.splice(0, account.baskets.length);
        }
      }
    }
  }

  // Publish shared state for web UI (?live=1) — Redis/Postgres, not MetaAPI.
  // Fail-open: always persist balance/equity even if liveState columns lag migrate.
  await setAccountLiveState({
    accountId: account.id,
    metaApiAccountId: metaId,
    balance: snap.balance,
    equity: snap.equity,
    margin: snap.margin,
    freeMargin: snap.freeMargin,
    leverage: snap.leverage,
    currency: snap.currency,
    connectionStatus: snap.connectionStatus,
    positions: snap.positions,
  });
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

  // H8 time logics: flatten on new bar + snap barOpen before building bot list
  let h8ClosedAny = false;
  let h8Positions: PosRow[] = snap.positions;
  for (const b of account.symbolBots) {
    if (!b.enabled && !openBaskets.some((x) => symbolsMatch(x.symbol, b.symbol))) continue;
    if (!isMartin9TimeLogic(b.logic)) continue;
    const sync = await syncH8TimeSession({
      accountId: account.id,
      metaId,
      symbol: b.symbol,
      logic: b.logic,
      positions: h8Positions,
      baskets: openBaskets,
    });
    h8Positions = sync.positions;
    if (sync.closed) {
      h8ClosedAny = true;
      // Prefer DB refresh for full basket row shape
      openBaskets = await prisma.basket.findMany({
        where: { accountId: account.id, status: "open" },
        include: { legs: true },
      });
    }
  }
  if (h8ClosedAny) {
    const fresh = await fetchSnapshot(metaId);
    if (fresh.ok) {
      snap = fresh;
      h8Positions = fresh.positions;
    }
    openBaskets = await prisma.basket.findMany({
      where: { accountId: account.id, status: "open" },
      include: { legs: true },
    });
  } else {
    // Keep snap.positions in sync for downstream (same reference when unchanged)
    h8Positions = snap.positions;
  }

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

  // 활성 봇 + 열린 바스켓(꺼진 종목 포함) 전부 틱 대상
  const forceManageOnly = resolveForceManageOnly(opts);
  const needed = new Map<string, NeededSide>();
  if (!forceManageOnly) {
    for (const b of account.symbolBots) {
      if (!b.enabled) continue;
      const logic = normalizeLogicId(b.logic);
      // H8 time: single basket per symbol (ignore dualDirection + DB direction).
      // Claim side with ownerLogic so a disabled 313 BUY row cannot steal ENTRY.
      if (isMartin9TimeLogic(logic)) {
        const st = h8SessionState.get(h8StateKey(account.id, b.symbol, logic));
        const dir = st?.direction;
        if (dir === "BUY" || dir === "SELL") {
          const key = `${b.symbol}|${dir}`;
          needed.set(
            key,
            mergeNeededSide(needed.get(key), {
              manageOnly: !masterOn,
              ownerLogic: logic,
            }),
          );
        } else if (!st?.entered) {
          // Direction chosen inside runSymbolTableDca — must still schedule a tick
          // or H8 never resolves (godcjfl flat-with-barOpen regression).
          const placeholder = b.direction === "SELL" ? "SELL" : "BUY";
          const key = `${b.symbol}|${placeholder}`;
          needed.set(
            key,
            mergeNeededSide(needed.get(key), {
              manageOnly: !masterOn,
              ownerLogic: logic,
            }),
          );
        }
        continue;
      }
      const dir = b.direction === "SELL" ? "SELL" : "BUY";
      const sides = b.dualDirection ? (["BUY", "SELL"] as const) : [dir];
      for (const side of sides) {
        const key = `${b.symbol}|${side}`;
        needed.set(
          key,
          mergeNeededSide(needed.get(key), {
            manageOnly: !masterOn,
            ownerLogic: logic,
          }),
        );
      }
    }
  }
  for (const basket of openBaskets) {
    const dir = (basket.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
    const key = `${basket.symbol}|${dir}`;
    const prev = needed.get(key);
    const canTrade = hasEnabledTraderForSide(
      account.symbolBots,
      basket.symbol,
      dir,
      prev?.ownerLogic,
    );
    const manageOnly = forceManageOnly || !masterOn || !canTrade;
    needed.set(key, mergeNeededSide(prev, { manageOnly, ownerLogic: prev?.ownerLogic }));
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
    const row = resolveSymbolBotForSide({
      bots: account.symbolBots,
      symbol: p.symbol,
      direction: dir,
      manageOnly: true,
    });
    const key = `${row?.symbol || p.symbol}|${dir}`;
    needed.set(key, mergeNeededSide(needed.get(key), { manageOnly: true }));
  }

  let bots: BotCfg[] = [];
  for (const [key, side] of needed) {
    const [symbol, direction] = key.split("|") as [string, "BUY" | "SELL"];
    const manageOnly = side.manageOnly;
    const row = resolveSymbolBotForSide({
      bots: account.symbolBots,
      symbol,
      direction,
      manageOnly,
      ownerLogic: side.ownerLogic,
    });
    if (row) {
      // Fail-closed: never map new risk onto a disabled / non-owner row.
      if (!manageOnly && !row.enabled) {
        console.error(
          `[engine] refuse new-risk bind disabled bot account=${account.id} ${symbol} ${direction} logic=${row.logic}`,
        );
        continue;
      }
      if (
        !manageOnly &&
        side.ownerLogic &&
        normalizeLogicId(row.logic) !== normalizeLogicId(side.ownerLogic)
      ) {
        console.error(
          `[engine] refuse logic mismatch account=${account.id} ${symbol} ${direction} want=${side.ownerLogic} got=${row.logic}`,
        );
        continue;
      }
      bots.push({ ...mapBotRow(row, manageOnly, direction), dualDirection: false });
      continue;
    }
    if (!manageOnly) {
      // No enabled owner row — skip ENTRY rather than invent a wrong logic.
      console.error(
        `[engine] refuse new-risk no owner row account=${account.id} ${symbol} ${direction} owner=${side.ownerLogic || "-"}`,
      );
      continue;
    }
    // 바스켓만 있고 SymbolBot 행이 없으면 기본 설정으로 관리만
    const c = account.config;
    const orphanLogic = "dubai_bruno_313";
    bots.push({
      symbol,
      logic: orphanLogic,
      direction,
      entryCount: c?.entryCount ?? tableLogicMeta("dubai_bruno_313").count,
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

  const tradedOk = results.some(
    (r) =>
      r &&
      typeof r === "object" &&
      "action" in r &&
      ["tp", "sl", "entry", "dca", "ghost_tp", "ghost_sl"].includes(
        String((r as { action?: string }).action || ""),
      ),
  );

  // Member UI: never sticky-alarm on soft/transient symbol errors while bot is on.
  await prisma.brokerAccount.update({
    where: { id: account.id },
    data: {
      statusMessage: masterOn
        ? "클라우드 연결 · 봇 실행 중"
        : "봇 중지 · 열린 포지션 익절·손절만 관리",
    },
  });

  // 오늘 실현 = MT5 딜 히스토리 (스로틀; 청산 틱만 force)
  try {
    const traded = tradedOk || results.some(
      (r) =>
        r &&
        typeof r === "object" &&
        "action" in r &&
        ["tp", "sl", "entry", "dca", "ghost_tp", "ghost_sl", "partial_force_close"].includes(
          String((r as { action?: string }).action || ""),
        ),
    );
    await syncTodayPnlFromMt5Deals({
      accountId: account.id,
      metaApiAccountId: metaId,
      equity: snap.equity,
      startingBalance: account.startingBalance,
      force: traded,
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
  /**
   * Backup/Vercel: manage open baskets only (no ENTRY/DCA).
   * Primary Render engine must leave this unset/false.
   */
  forceManageOnly?: boolean;
};

/**
 * Tick all botEnabled accounts whose owner is approved (or admin).
 * Rejected owners are skipped so ban gate applies to trading too.
 */
function resolveTickBudgetMs(optsBudget?: number): number {
  if (optsBudget != null && Number.isFinite(optsBudget)) return optsBudget;
  const fromEnv = Number(process.env.ENGINE_BUDGET_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  // Local direct engine: long window; fairness via concurrency + round-robin
  if (process.env.ENGINE_MODE === "direct") return 900_000;
  return 52_000;
}

/**
 * Tick concurrency for runAllBots.
 * Explicit ENGINE_CONCURRENCY wins. Else: Vercel backup=2, direct/default=4.
 */
export function resolveEngineConcurrency(): number {
  const fromEnv = Number(process.env.ENGINE_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) {
    return Math.min(32, Math.floor(fromEnv));
  }
  // Vercel/GHA backup ticks: low concurrency protects dedicated-FE REST budget.
  // Always-on Render (ENGINE_MODE=direct) can run more with warmed streams.
  if (process.env.VERCEL === "1") return 2;
  if ((process.env.ENGINE_MODE || "").trim() === "direct") return 4;
  return 4;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export async function runAllBots(opts: RunAllBotsOpts = {}) {
  const { undeployIdleAccounts } = await import("./cost-optimize");
  const budgetMs = resolveTickBudgetMs(opts.budgetMs);
  const started = Date.now();

  // Self-heal schema before any Prisma select that touches new columns
  await ensureTradingSchema();

  if (!opts.skipIdleUndeploy) {
    try {
      await undeployIdleAccounts();
    } catch {
      /* ignore */
    }
  }

  const forceManageOnly = resolveForceManageOnly(opts);
  const accounts = await prisma.brokerAccount.findMany({
    where: {
      metaApiAccountId: { not: null },
      status: { in: ["connected", "undeployed"] },
      user: {
        OR: [{ role: "admin" }, { approvalStatus: "approved" }],
      },
      // Backup manage-only: only accounts with open baskets (no flat ENTRY probing).
      // Primary: bot ON or open baskets.
      OR: forceManageOnly
        ? [{ baskets: { some: { status: "open" } } }]
        : [
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
  const maybeFloating = forceManageOnly
    ? []
    : await prisma.brokerAccount.findMany({
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

  // 열린 바스켓 계정 우선 — TP/SL 지정가 동기화·소프트 청산 지연 최소화
  const openBasketIds = await prisma.basket.groupBy({
    by: ["accountId"],
    where: {
      status: "open",
      accountId: { in: accounts.map((a) => a.id) },
    },
  });
  const openSet = new Set(openBasketIds.map((b) => b.accountId));
  accounts.sort((a, b) => {
    const ao = openSet.has(a.id) ? 0 : 1;
    const bo = openSet.has(b.id) ? 0 : 1;
    return ao - bo;
  });

  const results: Array<Record<string, unknown>> = [];
  let deferred = 0;
  const concurrency = resolveEngineConcurrency();
  const coldWaitCap =
    process.env.ENGINE_MODE === "direct"
      ? Math.min(20_000, Number(process.env.ENGINE_CLOUD_WAIT_MS || 15_000))
      : 8_000;

  const tickResults = await mapPool(accounts, concurrency, async (a) => {
    const elapsed = Date.now() - started;
    if (elapsed > budgetMs) {
      // Advance fairness cursor so deferred accounts rotate next cycle
      await prisma.brokerAccount
        .update({
          where: { id: a.id },
          data: { updatedAt: new Date() },
        })
        .catch(() => null);
      return { id: a.id, skipped: true as const, reason: "budget" };
    }
    try {
      if (a.status === "undeployed" && a.metaApiAccountId) {
        const remaining = Math.max(
          3_000,
          Math.min(coldWaitCap, budgetMs - elapsed - 1_000),
        );
        // Never wipe/recreate in trade loop — redeploy only
        const live = await ensureCloudLive(String(a.metaApiAccountId), remaining);
        if (!live.ok) {
          return {
            id: a.id,
            ok: false as const,
            error: live.message || "redeploy failed",
          };
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
      return { id: a.id, ...(await runDcaTick(a.id, { forceManageOnly: opts.forceManageOnly })) };
    } catch (e) {
      return {
        id: a.id,
        ok: false as const,
        error: e instanceof Error ? e.message : "tick error",
      };
    }
  });

  for (const r of tickResults) {
    if (r && typeof r === "object" && "skipped" in r && (r as { skipped?: boolean }).skipped) {
      deferred += 1;
    }
    results.push(r);
  }
  if (deferred > 0) {
    results.push({ deferred, reason: "time_budget", budgetMs, concurrency });
  }
  return results;
}
