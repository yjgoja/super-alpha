import levelsJson from "./presets/dca1000-levels.json";

export type Dca1000Level = {
  size: number;
  profit: number;
  drop: number;
};

/** 코인선물 전략표 레버 (손절 차트% 환산용; 익절·물타기는 MT5 계좌 레버 사용) */
export const DCA1000_LEVERAGE_BASE = (levelsJson as { leverageBase: number }).leverageBase || 20;

/** Zero Markets 등 MT5 계좌 레버 — 익절·물타기 ROI = 손익/사용증거금 */
export const MT5_BROKER_LEVERAGE_DEFAULT = 500;

/** Extracted rows = levels 1..N (물타기). Level 0 is implicit market entry. */
export const DCA1000_ROWS: Dca1000Level[] = (levelsJson as { levels: Dca1000Level[] }).levels;

/** Full table: [L0, ...rows] — L0 uses first row size/profit, drop=0 */
export const DCA1000_LEVELS: Dca1000Level[] = [
  {
    size: DCA1000_ROWS[0]?.size ?? 10,
    profit: DCA1000_ROWS[0]?.profit ?? 20,
    drop: 0,
  },
  ...DCA1000_ROWS,
];

/** size 10.0 → startLots (user setting = lot size for table size 10) */
export function lotsFromSize(size: number, startLots: number) {
  const raw = (size / 10) * startLots;
  return Math.max(0.01, Math.round(raw * 100) / 100);
}

/**
 * Coin table ROI% @ 20x → MT5 price distance %
 * (레버리지 포함 ROI를 현물/CFD 가격 이동으로 환산)
 */
export function roiToPricePct(roiPct: number, leverageBase = DCA1000_LEVERAGE_BASE) {
  return roiPct / Math.max(1, leverageBase);
}

/** 현재 스프레드 (중간가 대비 %) — MT5 Ask-Bid */
export function spreadPct(bid: number, ask: number) {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return 0;
  const mid = (bid + ask) / 2;
  return ((ask - bid) / mid) * 100;
}

/** MT5 시장가 진입 호가 */
export function mt5EntryQuote(direction: "BUY" | "SELL", bid: number, ask: number) {
  return direction === "BUY" ? ask : bid;
}

/** MT5 청산/평가 호가 (BUY→Bid, SELL→Ask) */
export function mt5ExitQuote(direction: "BUY" | "SELL", bid: number, ask: number) {
  return direction === "BUY" ? bid : ask;
}

/**
 * 물타기용 역행 % — 다음 진입도 같은 호가에 체결되므로
 * 진입가(Ask/Bid) 대비 동일 호가 이동만 본다.
 */
export function mt5DcaAdversePct(
  direction: "BUY" | "SELL",
  firstEntry: number,
  bid: number,
  ask: number,
) {
  if (!(firstEntry > 0)) return 0;
  const now = mt5EntryQuote(direction, bid, ask);
  if (direction === "BUY") {
    if (now >= firstEntry) return 0;
    return ((firstEntry - now) / firstEntry) * 100;
  }
  if (now <= firstEntry) return 0;
  return ((now - firstEntry) / firstEntry) * 100;
}

/**
 * 익절용 손익 % — MT5 플로팅과 동일 (청산 호가 vs 평단)
 */
export function mt5ProfitPct(
  direction: "BUY" | "SELL",
  avgEntry: number,
  bid: number,
  ask: number,
) {
  if (!(avgEntry > 0)) return 0;
  const mark = mt5ExitQuote(direction, bid, ask);
  return direction === "BUY"
    ? ((mark - avgEntry) / avgEntry) * 100
    : ((avgEntry - mark) / avgEntry) * 100;
}

/** 물타기 트리거: 표 drop ROI% (MT5 증거금 ROI와 비교) */
export function triggerDropRoi(
  levelIndex: number,
  levels: Dca1000Level[] = DCA1000_LEVELS,
) {
  if (levelIndex <= 0) return 0;
  const row = levels[levelIndex];
  if (!row) return Number.POSITIVE_INFINITY;
  return Math.max(0, row.drop);
}

/**
 * 물타기 트리거: 표 ROI → MT5 가격% (동일 호가 역행과 비교).
 * drop 10 ROI @20x → 차트 0.5%
 */
export function triggerPricePct(
  levelIndex: number,
  levels: Dca1000Level[] = DCA1000_LEVELS,
  leverageBase = DCA1000_LEVERAGE_BASE,
) {
  return roiToPricePct(triggerDropRoi(levelIndex, levels), leverageBase);
}

/**
 * 물타기용 역행 ROI% = 가격% × MT5 계좌 레버(기본 500).
 * 익절과 같이 증거금 ROI 정의에 맞춤. 표 drop ROI와 비교.
 */
export function mt5DcaAdverseRoi(
  direction: "BUY" | "SELL",
  firstEntry: number,
  bid: number,
  ask: number,
  leverageBase = MT5_BROKER_LEVERAGE_DEFAULT,
) {
  return mt5DcaAdversePct(direction, firstEntry, bid, ask) * Math.max(1, leverageBase);
}

/**
 * 익절 트리거: 표 ROI → 가격%.
 * MT5 청산 호가 기준 profit%와 비교하면 스프레드를 뚫고 목표 ROI와 같은 효과가 남.
 */
export function takeProfitPricePct(
  filledLevel: number,
  levels: Dca1000Level[] = DCA1000_LEVELS,
  leverageBase = DCA1000_LEVERAGE_BASE,
) {
  const row = levels[Math.max(0, Math.min(filledLevel, levels.length - 1))];
  return roiToPricePct(row?.profit ?? 20, leverageBase);
}

/**
 * 사용자 익절 ROI% (코인선물 표와 동일) → MT5 가격 이동%.
 * takeProfitRoiPct 미설정 시 해당 회차 표 profit ROI 사용.
 */
export function resolveTakeProfitPricePct(opts: {
  takeProfitRoiPct?: number;
  filledLevel?: number;
  levels?: Dca1000Level[];
  leverageBase?: number;
}) {
  const lev = opts.leverageBase ?? DCA1000_LEVERAGE_BASE;
  if (opts.takeProfitRoiPct != null && opts.takeProfitRoiPct > 0) {
    return roiToPricePct(opts.takeProfitRoiPct, lev);
  }
  return takeProfitPricePct(opts.filledLevel ?? 0, opts.levels, lev);
}

/** 가격% → 표 ROI% (레버 20 기준) */
export function pricePctToRoi(pricePct: number, leverageBase = DCA1000_LEVERAGE_BASE) {
  return pricePct * Math.max(1, leverageBase);
}

/** 심볼 계약 크기 (표준 MT5) */
export function contractSizeForSymbol(symbol: string) {
  const raw = (symbol || "EURUSD").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const key =
    raw === "GOLD" || raw.startsWith("XAU")
      ? "XAUUSD"
      : raw.startsWith("XAG") || raw === "SILVER"
        ? "XAGUSD"
        : raw;
  return MT5_CONTRACT_SIZE[key] ?? MT5_CONTRACT_SIZE.EURUSD;
}

/**
 * 현재 Bid/Ask 스프레드 비용($) — 포지션 수량 기준.
 * MT5 수익금은 이미 이 비용이 반영된 값이다.
 */
export function mt5SpreadCostMoney(opts: {
  symbol: string;
  lots: number;
  bid: number;
  ask: number;
}) {
  const lots = Math.max(0, opts.lots);
  const spread = Math.max(0, opts.ask - opts.bid);
  return lots * contractSizeForSymbol(opts.symbol) * spread;
}

/**
 * MT5와 동일한 미실현 손익($): 청산호가(Bid/Ask) vs 진입가.
 * 스프레드가 이미 포함된 금액 — 터미널 수익금과 같은 정의.
 */
export function mt5UnrealizedMoney(opts: {
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  openPrice: number;
  bid: number;
  ask: number;
}) {
  const lots = Math.max(0, opts.lots);
  const open = Math.max(0, opts.openPrice);
  if (!(lots > 0) || !(open > 0) || !(opts.bid > 0) || !(opts.ask > 0)) return 0;
  const exit = mt5ExitQuote(opts.direction, opts.bid, opts.ask);
  const move = opts.direction === "BUY" ? exit - open : open - exit;
  return move * contractSizeForSymbol(opts.symbol) * lots;
}

/**
 * MT5 사용 증거금 추정($) = 명목가치 ÷ 계좌 레버(1:500).
 * 바이낸스 증거금과 같이 ROI 분모로 쓴다.
 */
export function mt5UsedMargin(opts: {
  symbol: string;
  lots: number;
  avgPrice: number;
  brokerLeverage?: number;
}) {
  const lev = Math.max(1, opts.brokerLeverage ?? MT5_BROKER_LEVERAGE_DEFAULT);
  const lots = Math.max(0, opts.lots);
  const price = Math.max(0, opts.avgPrice);
  const notional = lots * contractSizeForSymbol(opts.symbol) * price;
  return notional / lev;
}

/** 플로팅 손익 ROI% = 손익 ÷ 사용증거금 × 100 (바이낸스 ROI와 동일 정의) */
export function mt5FloatingRoiPct(pnl: number, usedMargin: number) {
  if (!(usedMargin > 0)) return 0;
  return (pnl / usedMargin) * 100;
}

/**
 * 심볼 바스켓(합산) 익절 판정.
 * UI 익절값은 ROI% — 목표$ = 사용증거금 × ROI%/100.
 * 포지션별이 아니라 합산 pnl / 합산 증거금으로 비교한다.
 */
export function shouldTriggerTakeProfit(opts: {
  /** 심볼 합산 미실현 손익($) */
  pnl: number;
  usedMargin: number;
  tpRoiPct: number;
}) {
  const tpRoi = Math.max(0, opts.tpRoiPct);
  const floatingRoi = mt5FloatingRoiPct(opts.pnl, opts.usedMargin);
  const tpMoney =
    opts.usedMargin > 0
      ? Math.round(opts.usedMargin * (tpRoi / 100) * 100) / 100
      : 0;
  const hit =
    tpRoi > 0 &&
    opts.usedMargin > 0 &&
    (floatingRoi >= tpRoi || opts.pnl >= tpMoney);
  return { hit, floatingRoi, tpMoney, tpRoi };
}

/**
 * 익절 목표 금액($) = 사용증거금 × (ROI% / 100)
 * 예: XAU 0.01로트 @4080, 레버 500, ROI20
 *     명목 4080 → 증거금 8.16 → 익절 $1.63
 * 바이낸스: 증거금1 · ROI20% → 수익 0.2 와 같은 방식.
 */
export function mt5TpMoneyTarget(opts: {
  symbol: string;
  lots: number;
  avgPrice: number;
  tpRoiPct: number;
  /** MT5 계좌 레버리지 (기본 500). 코인 20배와 혼동 금지 */
  brokerLeverage?: number;
  /** @deprecated leverageBase → brokerLeverage */
  leverageBase?: number;
  bid?: number;
  ask?: number;
}) {
  const lev = Math.max(
    1,
    opts.brokerLeverage ?? opts.leverageBase ?? MT5_BROKER_LEVERAGE_DEFAULT,
  );
  const margin = mt5UsedMargin({
    symbol: opts.symbol,
    lots: opts.lots,
    avgPrice: opts.avgPrice,
    brokerLeverage: lev,
  });
  const tpRoi = Math.max(0, opts.tpRoiPct);
  return Math.round(margin * (tpRoi / 100) * 100) / 100;
}

/** 익절 판정용: API 수익과 호가 계산 수익 중 MT5에 가까운 값 */
export function mt5PnlForTakeProfit(opts: {
  apiProfit: number;
  symbol: string;
  direction: "BUY" | "SELL";
  legs: { lots: number; price: number }[];
  bid: number;
  ask: number;
}) {
  const quotePnl = opts.legs.reduce(
    (s, leg) =>
      s +
      mt5UnrealizedMoney({
        symbol: opts.symbol,
        direction: opts.direction,
        lots: leg.lots,
        openPrice: leg.price,
        bid: opts.bid,
        ask: opts.ask,
      }),
    0,
  );
  // 터미널 수익(스프레드 반영)과 라이브 호가 손익 중 큰 쪽으로 익절 — 지연으로 놓치는 것 방지
  const api = Number.isFinite(opts.apiProfit) ? opts.apiProfit : quotePnl;
  return {
    pnl: Math.max(api, quotePnl),
    apiProfit: api,
    quotePnl: Math.round(quotePnl * 100) / 100,
    spreadCost: mt5SpreadCostMoney({
      symbol: opts.symbol,
      lots: opts.legs.reduce((s, l) => s + l.lots, 0),
      bid: opts.bid,
      ask: opts.ask,
    }),
  };
}

/** 회차까지 채웠을 때 예상 익절금 (표 size → 로트) */
export function estimateTpMoneyForLevels(opts: {
  symbol: string;
  levels: Dca1000Level[];
  filledThrough: number;
  startLots?: number;
  tpRoiPct?: number;
  refMid?: number;
  leverageBase?: number;
}) {
  const startLots = opts.startLots ?? DCA1000_REF_LOTS;
  const lev = opts.leverageBase ?? DCA1000_LEVERAGE_BASE;
  const sym = (opts.symbol || "EURUSD").toUpperCase();
  const mid = opts.refMid ?? MT5_REF_MID[sym] ?? MT5_REF_MID.EURUSD;
  const through = Math.max(0, Math.min(opts.filledThrough, opts.levels.length - 1));
  let totalLots = 0;
  let sumPx = 0;
  for (let i = 0; i <= through; i++) {
    const lv = opts.levels[i];
    const lots = lotsFromSize(lv.size, startLots);
    const adverse = i === 0 ? 0 : lv.drop / lev / 100;
    const px = mid * (1 - adverse);
    totalLots += lots;
    sumPx += lots * px;
  }
  const avg = totalLots > 0 ? sumPx / totalLots : mid;
  const tpRoi =
    opts.tpRoiPct != null && opts.tpRoiPct > 0
      ? opts.tpRoiPct
      : opts.levels[through]?.profit ?? 20;
  const money = mt5TpMoneyTarget({
    symbol: opts.symbol,
    lots: totalLots,
    avgPrice: avg,
    tpRoiPct: tpRoi,
    brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
  });
  return {
    filledThrough: through,
    levelsUsed: through + 1,
    totalLots: Math.round(totalLots * 100) / 100,
    avgPrice: Math.round(avg * 100) / 100,
    tpRoiPct: tpRoi,
    tpMoney: Math.round(money * 100) / 100,
  };
}

export function summarizeDca1000(levels = DCA1000_LEVELS) {
  return {
    count: levels.length,
    dcaRows: DCA1000_ROWS.length,
    leverageBase: DCA1000_LEVERAGE_BASE,
    firstDropRoi: DCA1000_ROWS[0]?.drop ?? 10,
    firstDropPricePct: roiToPricePct(DCA1000_ROWS[0]?.drop ?? 10),
    firstTpRoi: levels[0]?.profit ?? 20,
    firstTpPricePct: roiToPricePct(levels[0]?.profit ?? 20),
    lastDropRoi: levels[levels.length - 1]?.drop,
    lastProfitRoi: levels[levels.length - 1]?.profit,
  };
}

/** Default coin-futures SL ROI% for 1000-step logic (표 기준) */
export const DCA1000_DEFAULT_SL_ROI = 225;
export const DCA1000_REF_LOTS = 0.01;

/** Zero Markets 기준 대표 스프레드 (절대가) — 유저 제보 EUR 25~28 / XAU 38~40 */
export const MT5_DEFAULT_SPREAD_ABS: Record<string, number> = {
  EURUSD: 0.00028,
  GBPUSD: 0.0003,
  USDJPY: 0.03,
  XAUUSD: 0.4,
  XAUEUR: 0.4,
  XAGUSD: 0.03,
  BTCUSD: 25,
  WTI: 0.03,
  XTIUSD: 0.03,
  XBRUSD: 0.03,
};

export const MT5_REF_MID: Record<string, number> = {
  EURUSD: 1.085,
  GBPUSD: 1.27,
  USDJPY: 155,
  XAUUSD: 4080,
  XAUEUR: 2150,
  XAGUSD: 28,
  BTCUSD: 65000,
  WTI: 75,
  XTIUSD: 75,
  XBRUSD: 80,
};

/** 심볼 계약 크기 (표준 MT5) — 손절금(계좌통화) 환산용 */
export const MT5_CONTRACT_SIZE: Record<string, number> = {
  EURUSD: 100_000,
  GBPUSD: 100_000,
  USDJPY: 100_000,
  XAUUSD: 100,
  XAUEUR: 100,
  XAGUSD: 5000,
  BTCUSD: 1,
  WTI: 100,
  XTIUSD: 100,
  XBRUSD: 100,
};

/** MT5 point size (SYMBOL_POINT) — 스프레드 pt 표시용 */
export const MT5_POINT: Record<string, number> = {
  EURUSD: 0.00001,
  GBPUSD: 0.00001,
  USDJPY: 0.001,
  XAUUSD: 0.01,
  XAUEUR: 0.01,
  XAGUSD: 0.001,
  BTCUSD: 0.01,
  WTI: 0.01,
  XTIUSD: 0.01,
  XBRUSD: 0.01,
};

export function resolveMt5Spread(symbol?: string, overrideAbs?: number) {
  const sym = (symbol || "EURUSD").toUpperCase();
  const mid = MT5_REF_MID[sym] ?? MT5_REF_MID.EURUSD;
  const abs = overrideAbs ?? MT5_DEFAULT_SPREAD_ABS[sym] ?? mid * 0.00026;
  const pct = mid > 0 ? (abs / mid) * 100 : 0;
  const point = MT5_POINT[sym] ?? (abs >= 0.01 ? 0.01 : 0.00001);
  const points = Math.round((abs / point) * 10) / 10;
  return { symbol: sym, mid, spreadAbs: abs, spreadPct: pct, spreadPoints: points, point };
}

function round2(n: number) {
  return Math.round(n * 100 + Number.EPSILON) / 100;
}

function round4(n: number) {
  return Math.round(n * 10000 + Number.EPSILON) / 10000;
}

export type Dca1000Defense = {
  stopLossRoiPct: number;
  leverage: number;
  levelCount: number;
  totalSize: number;
  /** BUY: 첫 진입 미드 대비 차트 하락 % (스프레드 반영) */
  spotLongPct: number;
  /** SELL: 첫 진입 미드 대비 차트 상승 % (스프레드 반영) */
  spotShortPct: number;
  /** Buy/Sell 차트 방어폭 평균 */
  roiDefensePct: number;
  /**
   * 전체 회차 소진 후 손절 시 예상 손실(계좌).
   * 엔진과 동일: 청산호가 기준 평단 대비 -SL_ROI/레버 도달 시 P&L.
   */
  estimatedSlAmount: number;
  /** 표 마진×손절ROI */
  tableMarginSlAmount: number;
  /** MT5 계약·로트 기준 현금 손절(전체 회차 채움, 참고) */
  mt5CashSlAmount: number;
  avgEntryLong: number;
  avgEntryShort: number;
  spreadPct: number;
  spreadAbs: number;
  spreadPoints: number;
  refMid: number;
  symbol: string;
  /** 손절 트리거 가격% (청산호가 기준, = SL_ROI/레버) */
  slTriggerPricePct: number;
};

/**
 * MT5 호가 모델로 전체 회차 소진 → 손절 시점 시뮬레이션.
 *
 * BUY: Ask 진입/물타기, Bid 손절평가. 차트% = 미드 이동.
 * SELL: Bid 진입/물타기, Ask 손절평가.
 * 물타기 간격 = 표 dropROI/레버 (동일 호가 역행, 엔진과 동일).
 * 손절 = 청산호가 대비 평단 손익% <= -(SL_ROI/레버).
 */
export function calcDca1000Defense(opts?: {
  stopLossRoiPct?: number;
  startLots?: number;
  leverage?: number;
  levels?: Dca1000Level[];
  symbol?: string;
  spreadAbs?: number;
  refMid?: number;
}): Dca1000Defense {
  const lev = opts?.leverage ?? DCA1000_LEVERAGE_BASE;
  const slRoi = Math.max(0, opts?.stopLossRoiPct ?? DCA1000_DEFAULT_SL_ROI);
  const startLots = Math.max(0.01, opts?.startLots ?? DCA1000_REF_LOTS);
  const levels = opts?.levels ?? DCA1000_LEVELS;
  const spreadInfo = resolveMt5Spread(opts?.symbol, opts?.spreadAbs);
  const mid0 = opts?.refMid ?? spreadInfo.mid;
  const sprAbs = opts?.spreadAbs ?? spreadInfo.spreadAbs;
  const half = sprAbs / 2;
  const ask0 = mid0 + half;
  const bid0 = mid0 - half;
  const sprPct = mid0 > 0 ? (sprAbs / mid0) * 100 : 0;
  const slFactor = slRoi / (Math.max(1, lev) * 100);
  const slTriggerPricePct = (slRoi / Math.max(1, lev));

  let totalSize = 0;
  let sumAsk = 0;
  let sumBid = 0;
  let totalLots = 0;

  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    const drop = i === 0 ? 0 : lv.drop;
    const adverse = drop / Math.max(1, lev) / 100;
    // 동일 호가 경로 (엔진 mt5DcaAdversePct와 동일)
    const ask = ask0 * (1 - adverse);
    const bid = bid0 * (1 + adverse);
    const lots = lotsFromSize(lv.size, startLots);
    totalSize += lv.size;
    sumAsk += lv.size * ask;
    sumBid += lv.size * bid;
    totalLots += lots;
  }

  const avgAsk = totalSize > 0 ? sumAsk / totalSize : ask0;
  const avgBid = totalSize > 0 ? sumBid / totalSize : bid0;

  // BUY SL: Bid_sl = avgAsk * (1 - slFactor), mid = Bid + half
  const buySlBid = avgAsk * (1 - slFactor);
  const buySlMid = buySlBid + half;
  const spotLongPct = mid0 > 0 ? Math.max(0, ((mid0 - buySlMid) / mid0) * 100) : 0;

  // SELL SL: Ask_sl = avgBid * (1 + slFactor), mid = Ask - half
  const sellSlAsk = avgBid * (1 + slFactor);
  const sellSlMid = sellSlAsk - half;
  const spotShortPct = mid0 > 0 ? Math.max(0, ((sellSlMid - mid0) / mid0) * 100) : 0;

  const roiDefensePct = (spotLongPct + spotShortPct) / 2;

  // 표 마진 손절금 — 엔진 손절(청산호가 손익% = -SL_ROI/레버)과 동일한 ROI 정의
  // Size는 레버 포함 수량 단위 → 마진=Size/레버, 손실=마진×(SL_ROI/100)×로트스케일
  const lotScale = startLots / DCA1000_REF_LOTS;
  const tableMarginSlAmount =
    (totalSize / Math.max(1, lev)) * (slRoi / 100) * lotScale;

  // MT5 현금 손절(참고): 전체 회차를 실제 로트로 채웠을 때 청산호가 기준 P&L
  const sym = spreadInfo.symbol;
  const contract = MT5_CONTRACT_SIZE[sym] ?? MT5_CONTRACT_SIZE.EURUSD;
  const buySlMove = Math.max(0, avgAsk - buySlBid);
  const sellSlMove = Math.max(0, sellSlAsk - avgBid);
  const mt5CashSlAmount = ((buySlMove + sellSlMove) / 2) * contract * totalLots;

  return {
    stopLossRoiPct: slRoi,
    leverage: lev,
    levelCount: levels.length,
    totalSize: round2(totalSize),
    spotLongPct: round2(spotLongPct),
    spotShortPct: round2(spotShortPct),
    roiDefensePct: round2(roiDefensePct),
    estimatedSlAmount: round2(tableMarginSlAmount),
    tableMarginSlAmount: round2(tableMarginSlAmount),
    mt5CashSlAmount: round2(mt5CashSlAmount),
    avgEntryLong: round4(avgAsk / ask0),
    avgEntryShort: round4(avgBid / bid0),
    spreadPct: round4(sprPct),
    spreadAbs: sprAbs,
    spreadPoints: spreadInfo.spreadPoints,
    refMid: mid0,
    symbol: sym,
    slTriggerPricePct: round4(slTriggerPricePct),
  };
}

/** Precomputed default (EURUSD · SL 225% · 0.01 lot) */
export const DCA1000_DEFAULT_DEFENSE = calcDca1000Defense({ symbol: "EURUSD" });
