import levelsJson from "./presets/dca1000-levels.json";

export type Dca1000Level = {
  size: number;
  profit: number;
  drop: number;
};

/** 코인선물 전략표 레버 (물타기 drop ROI→가격% 참고·레거시 환산용) */
export const DCA1000_LEVERAGE_BASE = (levelsJson as { leverageBase: number }).leverageBase || 20;

/** Zero Markets 등 MT5 계좌 레버 — 익절·손절·물타기 ROI = 손익/사용증거금 */
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

/** 심볼 POINT (가격 반올림용) */
export function pointForSymbol(symbol: string) {
  const raw = (symbol || "EURUSD").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const key =
    raw === "GOLD" || raw.startsWith("XAU")
      ? "XAUUSD"
      : raw.startsWith("XAG") || raw === "SILVER"
        ? "XAGUSD"
        : raw;
  return MT5_POINT[key] ?? (key.includes("JPY") ? 0.001 : key.startsWith("XAU") ? 0.01 : 0.00001);
}

/** 가격을 심볼 point 단위로 반올림 */
export function roundPriceToPoint(price: number, point: number) {
  if (!(price > 0) || !(point > 0)) return price;
  return Math.round(price / point) * point;
}

/**
 * 바스켓 TP$/SL$ → 전 레그에 심을 동일 브로커 지정가.
 * BUY: tp = avg + TP$/(lots·cs), sl = avg − SL$/(lots·cs)
 * SELL: 반대.
 */
export function basketExitPricesFromUsd(opts: {
  symbol: string;
  direction: "BUY" | "SELL";
  avgPrice: number;
  lots: number;
  takeProfitUsd: number;
  stopLossUsd: number;
}) {
  const lots = Math.max(0, opts.lots);
  const avg = Math.max(0, opts.avgPrice);
  const cs = contractSizeForSymbol(opts.symbol);
  const point = pointForSymbol(opts.symbol);
  const denom = lots * cs;
  if (!(denom > 0) || !(avg > 0)) {
    return {
      takeProfit: null as number | null,
      stopLoss: null as number | null,
      point,
      denom: 0,
    };
  }
  const tpMove = opts.takeProfitUsd > 0 ? opts.takeProfitUsd / denom : 0;
  const slMove = opts.stopLossUsd > 0 ? opts.stopLossUsd / denom : 0;
  let takeProfit: number | null = null;
  let stopLoss: number | null = null;
  if (opts.direction === "BUY") {
    if (tpMove > 0) takeProfit = roundPriceToPoint(avg + tpMove, point);
    if (slMove > 0) stopLoss = roundPriceToPoint(avg - slMove, point);
    if (takeProfit != null && !(takeProfit > avg)) takeProfit = null;
    if (stopLoss != null && !(stopLoss < avg)) stopLoss = null;
  } else {
    if (tpMove > 0) takeProfit = roundPriceToPoint(avg - tpMove, point);
    if (slMove > 0) stopLoss = roundPriceToPoint(avg + slMove, point);
    if (takeProfit != null && !(takeProfit < avg)) takeProfit = null;
    if (stopLoss != null && !(stopLoss > avg)) stopLoss = null;
  }
  return { takeProfit, stopLoss, point, denom, tpMove, slMove };
}

/**
 * 바스켓 공통 지정가를 전 레그 openPrice 기준으로 브로커 유효 범위에 맞춤.
 * SELL TP는 모든 open 미만, BUY TP는 모든 open 초과여야 MT5가 수락한다.
 * stopsLevel(포인트)만큼 최소 이격을 강제한다.
 */
export function clampBasketProtectForLegs(opts: {
  direction: "BUY" | "SELL";
  openPrices: number[];
  takeProfit: number | null;
  stopLoss: number | null;
  point: number;
  /** 브로커 SYMBOL_TRADE_STOPS_LEVEL (포인트). 0이면 2틱 */
  stopsLevelPoints?: number;
}) {
  const opens = opts.openPrices.filter((p) => p > 0);
  if (opens.length === 0) {
    return { takeProfit: opts.takeProfit, stopLoss: opts.stopLoss };
  }
  const point = opts.point > 0 ? opts.point : 0.00001;
  const stopsPts = Math.max(2, opts.stopsLevelPoints ?? 0, 2);
  const pad = point * stopsPts;
  const minOpen = Math.min(...opens);
  const maxOpen = Math.max(...opens);
  let takeProfit = opts.takeProfit;
  let stopLoss = opts.stopLoss;
  if (opts.direction === "BUY") {
    if (takeProfit != null) {
      const floor = roundPriceToPoint(maxOpen + pad, point);
      takeProfit = roundPriceToPoint(Math.max(takeProfit, floor), point);
    }
    if (stopLoss != null) {
      const ceil = roundPriceToPoint(minOpen - pad, point);
      stopLoss = roundPriceToPoint(Math.min(stopLoss, ceil), point);
      if (!(stopLoss < minOpen - point)) stopLoss = null;
    }
  } else {
    if (takeProfit != null) {
      const ceil = roundPriceToPoint(minOpen - pad, point);
      takeProfit = roundPriceToPoint(Math.min(takeProfit, ceil), point);
      if (!(takeProfit < minOpen - point)) takeProfit = null;
    }
    if (stopLoss != null) {
      const floor = roundPriceToPoint(maxOpen + pad, point);
      stopLoss = roundPriceToPoint(Math.max(stopLoss, floor), point);
    }
  }
  return { takeProfit, stopLoss };
}

/** 브로커에 심긴 TP/SL이 목표와 허용오차(틱) 이내인지 */
export function brokerProtectionMatches(opts: {
  current: number | null | undefined;
  target: number | null | undefined;
  point: number;
  /** 허용 틱 수 (기본 2) */
  tolTicks?: number;
}) {
  const target = opts.target;
  if (target == null || !(target > 0)) return true; // 목표 없음 = 비교 스킵
  const cur = opts.current;
  if (cur == null || !(cur > 0)) return false;
  const point = opts.point > 0 ? opts.point : 0.00001;
  const tol = Math.max(1, opts.tolTicks ?? 2) * point;
  return Math.abs(cur - target) <= tol + 1e-12;
}

/** ROI% → 달러 (증거금 × ROI%/100). 코인: 마진10 × ROI20% = $2 */
export function roiPctToUsd(marginUsd: number, roiPct: number) {
  if (!(marginUsd > 0) || !(roiPct > 0)) return 0;
  return Math.round(marginUsd * (roiPct / 100) * 100) / 100;
}

/**
 * @deprecated 예전 차트% 방어 손절$. 엔진은 더 이상 사용하지 않음.
 * 현재 SL = 바스켓 증거금 × (SL_ROI/100) — `roiPctToUsd` / `liveBasketTpSlUsd`.
 * 차트% = 명목 × (SL_ROI / 표레버 / 100). SL_ROI 225 · 표레버 20 → 가격 11.25%.
 */
export function chartDefenseSlUsd(opts: {
  symbol: string;
  lots: number;
  avgPrice: number;
  stopLossPct: number;
  /** 표 레버(기본 20). 브로커 레버와 다름 */
  tableLeverage?: number;
}) {
  const lots = Math.max(0, opts.lots);
  const avg = Math.max(0, opts.avgPrice);
  const slRoi = Math.max(0, opts.stopLossPct);
  const tableLev = Math.max(1, opts.tableLeverage ?? DCA1000_LEVERAGE_BASE);
  if (!(lots > 0) || !(avg > 0) || !(slRoi > 0)) return 0;
  const notional = lots * contractSizeForSymbol(opts.symbol) * avg;
  return Math.round(notional * (slRoi / tableLev / 100) * 100) / 100;
}

/**
 * 바스켓 사용증거금($). 브로커(MetaAPI) margin 합이 있으면 우선, 없으면
 * Lot × ContractSize × MarketPrice ÷ Leverage.
 */
export function basketMarginUsd(opts: {
  symbol: string;
  lots: number;
  avgPrice: number;
  brokerLeverage?: number;
  /** MetaAPI 포지션 margin 합 (있으면 우선) */
  brokerMarginSum?: number | null;
}) {
  if (opts.brokerMarginSum != null && opts.brokerMarginSum > 0) {
    return opts.brokerMarginSum;
  }
  return mt5UsedMargin({
    symbol: opts.symbol,
    lots: opts.lots,
    avgPrice: opts.avgPrice,
    brokerLeverage: opts.brokerLeverage ?? MT5_BROKER_LEVERAGE_DEFAULT,
  });
}

/** 시작로트 기준 사용증거금($) — L0 미리보기·에디터 분모 */
export function startLotsMarginUsd(opts: {
  symbol: string;
  startLots: number;
  brokerLeverage?: number;
  refMid?: number;
}) {
  const raw = (opts.symbol || "EURUSD").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const key =
    raw === "GOLD" || raw.startsWith("XAU")
      ? "XAUUSD"
      : raw.startsWith("XAG") || raw === "SILVER"
        ? "XAGUSD"
        : raw in MT5_REF_MID
          ? raw
          : "EURUSD";
  const mid = opts.refMid ?? MT5_REF_MID[key] ?? MT5_REF_MID.EURUSD;
  return mt5UsedMargin({
    symbol: opts.symbol,
    lots: Math.max(0.01, opts.startLots),
    avgPrice: mid,
    brokerLeverage: opts.brokerLeverage ?? MT5_BROKER_LEVERAGE_DEFAULT,
  });
}

/**
 * L0(시작로트) 기준 익절$/손절$ 미리보기 — 엔진 트리거가 아님(라이브는 liveBasketTpSlUsd).
 * 바이낸스 선물식: 익절·손절 모두 시작로트 증거금 × ROI%.
 * useFixedUsd=true 일 때만 저장 오버라이드$ 사용.
 */
export function resolveTpSlUsd(opts: {
  symbol: string;
  startLots: number;
  takeProfitUsd?: number | null;
  stopLossUsd?: number | null;
  takeProfitPct?: number | null;
  stopLossPct?: number | null;
  brokerLeverage?: number;
  refMid?: number;
  /** true면 저장 고정$ 우선 (레거시). 기본 false = pct 파생 */
  useFixedUsd?: boolean;
}) {
  const lots = Math.max(0.01, opts.startLots);
  const raw = (opts.symbol || "EURUSD").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const key =
    raw === "GOLD" || raw.startsWith("XAU")
      ? "XAUUSD"
      : raw.startsWith("XAG") || raw === "SILVER"
        ? "XAGUSD"
        : raw in MT5_REF_MID
          ? raw
          : "EURUSD";
  const mid = opts.refMid ?? MT5_REF_MID[key] ?? MT5_REF_MID.EURUSD;
  const marginUsd = mt5UsedMargin({
    symbol: opts.symbol,
    lots,
    avgPrice: mid,
    brokerLeverage: opts.brokerLeverage ?? MT5_BROKER_LEVERAGE_DEFAULT,
  });
  const tpRoi =
    opts.takeProfitPct != null && opts.takeProfitPct > 0 ? opts.takeProfitPct : 20;
  const slRoi =
    opts.stopLossPct != null && opts.stopLossPct > 0
      ? opts.stopLossPct
      : DCA1000_DEFAULT_SL_ROI;
  const derivedTp = roiPctToUsd(marginUsd, tpRoi);
  const derivedSl = roiPctToUsd(marginUsd, slRoi);
  const useFixed = opts.useFixedUsd === true;
  const takeProfitUsd =
    useFixed && opts.takeProfitUsd != null && opts.takeProfitUsd > 0
      ? Math.round(opts.takeProfitUsd * 100) / 100
      : derivedTp;
  const stopLossUsd =
    useFixed && opts.stopLossUsd != null && opts.stopLossUsd > 0
      ? Math.round(opts.stopLossUsd * 100) / 100
      : derivedSl;
  return {
    marginUsd: Math.round(marginUsd * 100) / 100,
    takeProfitUsd,
    stopLossUsd,
    takeProfitPct: tpRoi,
    stopLossPct: slRoi,
    derivedTakeProfitUsd: derivedTp,
    derivedStopLossUsd: derivedSl,
  };
}

/**
 * 라이브 바스켓 익절$/손절$ — 회차·로트에 따라 커짐 (바이낸스 마진 ROI).
 * - TP$ = BasketMargin × (takeProfitPct/100)
 * - SL$ = BasketMargin × (stopLossPct/100)
 * BasketMargin = 브로커 margin 합 우선, 없으면 Lot×Contract×Price÷Leverage.
 * useFixedUsd=true 이고 오버라이드$ > 0 이면 고정$ (레거시·수동 고정).
 */
export function liveBasketTpSlUsd(opts: {
  symbol: string;
  lots: number;
  avgPrice: number;
  takeProfitPct: number;
  stopLossPct: number;
  brokerLeverage?: number;
  /** MetaAPI 포지션 margin 합 — 있으면 ROI 분모로 우선 */
  brokerMarginSum?: number | null;
  takeProfitUsdOverride?: number | null;
  stopLossUsdOverride?: number | null;
  /** true면 저장된 고정$ 사용 (기본 false = 회차 스케일) */
  useFixedUsd?: boolean;
}) {
  const tpRoi = opts.takeProfitPct > 0 ? opts.takeProfitPct : 20;
  const slRoi = opts.stopLossPct > 0 ? opts.stopLossPct : DCA1000_DEFAULT_SL_ROI;
  const lots = Math.max(0, opts.lots);
  const avg = Math.max(0, opts.avgPrice);
  const marginUsd = basketMarginUsd({
    symbol: opts.symbol,
    lots,
    avgPrice: avg,
    brokerLeverage: opts.brokerLeverage ?? MT5_BROKER_LEVERAGE_DEFAULT,
    brokerMarginSum: opts.brokerMarginSum,
  });
  const liveTp = roiPctToUsd(marginUsd, tpRoi);
  const liveSl = roiPctToUsd(marginUsd, slRoi);
  const useFixed = opts.useFixedUsd === true;
  const takeProfitUsd =
    useFixed && opts.takeProfitUsdOverride != null && opts.takeProfitUsdOverride > 0
      ? Math.round(opts.takeProfitUsdOverride * 100) / 100
      : liveTp;
  const stopLossUsd =
    useFixed && opts.stopLossUsdOverride != null && opts.stopLossUsdOverride > 0
      ? Math.round(opts.stopLossUsdOverride * 100) / 100
      : liveSl;
  return {
    marginUsd: Math.round(marginUsd * 100) / 100,
    takeProfitUsd,
    stopLossUsd,
    takeProfitPct: tpRoi,
    stopLossPct: slRoi,
    live: !useFixed,
  };
}

/**
 * 심볼 바스켓(합산) 익절 판정 — 바이낸스 마진 ROI.
 * BasketROI = pnl/usedMargin×100 ≥ tpRoiPct → 전량 청산.
 * (동치) pnl ≥ takeProfitUsd (= margin×TP%/100).
 */
/** ROI% 비교 허용오차 — float (pnl/margin*100) 경계 미달 방지 */
const ROI_CMP_EPS = 1e-6;

export function shouldTriggerTakeProfit(opts: {
  /** 심볼 합산 미실현 손익($) = BasketProfit */
  pnl: number;
  /** 익절 목표($). 라이브 바스켓 기준값 전달 */
  takeProfitUsd: number;
  /** BasketMargin — ROI 분모 */
  usedMargin?: number;
  tpRoiPct?: number;
  /** @deprecated ROI 경로 — takeProfitUsd 없을 때만 사용 */
  tpRoiPctLegacy?: number;
}) {
  const margin = Math.max(0, opts.usedMargin ?? 0);
  const tpRoi = opts.tpRoiPct ?? opts.tpRoiPctLegacy ?? 0;
  let tpMoney = Math.max(0, opts.takeProfitUsd);
  if (!(tpMoney > 0) && margin > 0 && tpRoi > 0) {
    tpMoney = roiPctToUsd(margin, tpRoi);
  }
  const floatingRoi = mt5FloatingRoiPct(opts.pnl, margin);
  // 마진 ROI와 $ 목표 동치 (반올림·float 오차 흡수: 둘 중 하나면 히트)
  const hitRoi = margin > 0 && tpRoi > 0 && floatingRoi + ROI_CMP_EPS >= tpRoi;
  const hitUsd = tpMoney > 0 && opts.pnl + 1e-9 >= tpMoney;
  return { hit: hitRoi || hitUsd, floatingRoi, tpMoney, tpRoi };
}

/**
 * 바스켓 손절 — 바이낸스 마진 ROI.
 * BasketROI ≤ -stopLossRoiPct → 전량 손절.
 * (동치) pnl ≤ -stopLossUsd (= margin×SL%/100).
 */
export function shouldTriggerStopLossUsd(opts: {
  pnl: number;
  stopLossUsd: number;
  usedMargin?: number;
  stopLossRoiPct?: number;
}) {
  const margin = Math.max(0, opts.usedMargin ?? 0);
  const slRoi = Math.max(0, opts.stopLossRoiPct ?? 0);
  let sl = Math.max(0, opts.stopLossUsd);
  if (!(sl > 0) && margin > 0 && slRoi > 0) {
    sl = roiPctToUsd(margin, slRoi);
  }
  const floatingRoi = mt5FloatingRoiPct(opts.pnl, margin);
  const hitRoi = margin > 0 && slRoi > 0 && floatingRoi - ROI_CMP_EPS <= -slRoi;
  const hitUsd = sl > 0 && opts.pnl - 1e-9 <= -sl;
  return {
    hit: hitRoi || hitUsd,
    stopLossUsd: sl,
    floatingRoi,
    stopLossRoiPct: slRoi,
  };
}

/**
 * 물타기 트리거 — 순수 바스켓 마진 ROI (가격 로직 없음, 바이낸스 선물식).
 * BasketROI = BasketFloatingProfit / BasketMargin × 100.
 * BasketROI ≤ -dropRoiPct(표 drop) 이면 다음 회차 진입.
 * 예: 표 drop 20 → 바스켓 ROI ≤ -20% 에서 2번째 주문 추가.
 */
export function shouldTriggerDcaRoi(opts: {
  /** 심볼 바스켓 합산 미실현 손익($) */
  pnl: number;
  /** 바스켓 사용증거금($) — 브로커 margin 합 우선 */
  usedMargin: number;
  /** 표 drop ROI% (양수, 예: 20/40/…/350) */
  dropRoiPct: number;
}) {
  const margin = Math.max(0, opts.usedMargin);
  const dropRoi = Math.max(0, opts.dropRoiPct);
  const basketRoi = mt5FloatingRoiPct(opts.pnl, margin);
  return {
    hit: margin > 0 && dropRoi > 0 && basketRoi - ROI_CMP_EPS <= -dropRoi,
    basketRoi,
    dropRoiPct: dropRoi,
    lossUsd: Math.max(0, -opts.pnl),
  };
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

/** 익절/손절 판정용 PnL — TP는 낙관(max), SL은 보수(min)로 분리해 손절 지연·익절 누락을 동시에 막는다. */
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
  const api = Number.isFinite(opts.apiProfit) ? opts.apiProfit : quotePnl;
  const quote = Math.round(quotePnl * 100) / 100;
  return {
    /** 익절용 — API/호가 중 큰 값 (지연으로 익절 놓침 방지) */
    pnl: Math.max(api, quotePnl),
    /** 손절용 — API/호가 중 작은 값 (손절 지연·미발동 방지) */
    pnlForSl: Math.min(api, quotePnl),
    apiProfit: api,
    quotePnl: quote,
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

/**
 * Default basket-ROI SL% for DCA ladder logic.
 * 소형 계좌 보호: 225%에서 조기 손절 (525% 풀사다리는 과레버리지 위험).
 * 회차 상한(entryCount)과 함께 바스켓 크기를 계좌에 맞게 제한한다.
 */
export const DCA1000_DEFAULT_SL_ROI = 225;
export const DCA1000_REF_LOTS = 0.01;

/** Zero Markets 기준 대표 스프레드 (절대가) — 유저 제보 EUR 25~28 / XAU 38~40 */
export const MT5_DEFAULT_SPREAD_ABS: Record<string, number> = {
  EURUSD: 0.00028,
  GBPUSD: 0.0003,
  AUDUSD: 0.00032,
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
  AUDUSD: 0.66,
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
  AUDUSD: 100_000,
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
  AUDUSD: 0.00001,
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
   * 전체 회차 소진 후 손절 시 예상 손실($).
   * 엔진과 동일: 바스켓 증거금 × (SL_ROI/100).
   */
  estimatedSlAmount: number;
  /** 코인선물 표 마진×손절ROI (참고·레거시) */
  tableMarginSlAmount: number;
  /** MT5 바스켓 마진 ROI 손절$ (전체 회차 채움) = estimatedSlAmount */
  mt5CashSlAmount: number;
  avgEntryLong: number;
  avgEntryShort: number;
  spreadPct: number;
  spreadAbs: number;
  spreadPoints: number;
  refMid: number;
  symbol: string;
  /** 코인선물 기준 평단 대비 손절 가격% (SL_ROI/표레버). 엔진은 ROI로 판정 */
  slTriggerPricePct: number;
};

/**
 * 전체 회차 소진 후 손절 참고 시뮬레이션.
 * 엔진 손절 = 바스켓 마진 ROI (BasketProfit/BasketMargin ≤ -SL_ROI%).
 * estimatedSlAmount = 전체 회차 바스켓 증거금 × (SL_ROI/100).
 * spot*Pct 는 참고용 차트 환산(표 레버)이며 엔진 트리거가 아님.
 */
export function calcDca1000Defense(opts?: {
  stopLossRoiPct?: number;
  startLots?: number;
  leverage?: number;
  levels?: Dca1000Level[];
  symbol?: string;
  spreadAbs?: number;
  refMid?: number;
  brokerLeverage?: number;
}): Dca1000Defense {
  const lev = opts?.leverage ?? DCA1000_LEVERAGE_BASE;
  const brokerLev = Math.max(1, opts?.brokerLeverage ?? MT5_BROKER_LEVERAGE_DEFAULT);
  const slRoi = Math.max(0, opts?.stopLossRoiPct ?? DCA1000_DEFAULT_SL_ROI);
  const startLots = Math.max(0.01, opts?.startLots ?? DCA1000_REF_LOTS);
  const levels = opts?.levels ?? DCA1000_LEVELS;
  const spreadInfo = resolveMt5Spread(opts?.symbol, opts?.spreadAbs);
  const mid0 = opts?.refMid ?? spreadInfo.mid;
  const sprAbs = opts?.spreadAbs ?? spreadInfo.spreadAbs;
  const sprPct = mid0 > 0 ? (sprAbs / mid0) * 100 : 0;
  // 코인선물 기준 방어폭 — 가격경로 시뮬레이션 (코인 툴과 소수점까지 일치).
  // 바스켓 마진 ROI = 표레버 × (P-평단)/평단 (평단 기준 증거금, 바이낸스식).
  // 수량 = 명목/체결가 (코인선물처럼 주문당 명목 고정). 평단 = 명목가중 VWAP.
  //  BUY  물타기: p = avg × (1 - drop/(100·lev)),  손절: avg × (1 - slRoi/(100·lev))
  //  SELL 물타기: p = avg × (1 + drop/(100·lev)),  손절: avg × (1 + slRoi/(100·lev))
  const slAvgFactor = slRoi / (lev * 100);
  const slTriggerPricePct = slRoi / lev; // 평단 대비 손절 가격%

  let totalSize = 0;
  let totalLots = 0;
  // 명목가중 평단(시작가=1 기준 비율) — 롱/숏 경로
  let sumQtyPLong = 0;
  let sumQtyLong = 0;
  let avgRatioLong = 1;
  let sumQtyPShort = 0;
  let sumQtyShort = 0;
  let avgRatioShort = 1;
  // 로트가중 평단(절대가) — MT5 증거금 분모용 (BUY 경로 기준)
  let sumLotMid = 0;

  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    const drop = i === 0 ? 0 : lv.drop;
    const dFactor = drop / (Math.max(1, lev) * 100);
    const pLong = i === 0 ? 1 : avgRatioLong * (1 - dFactor);
    const pShort = i === 0 ? 1 : avgRatioShort * (1 + dFactor);
    const qLong = lv.size / pLong;
    const qShort = lv.size / pShort;
    sumQtyPLong += qLong * pLong;
    sumQtyLong += qLong;
    avgRatioLong = sumQtyPLong / sumQtyLong;
    sumQtyPShort += qShort * pShort;
    sumQtyShort += qShort;
    avgRatioShort = sumQtyPShort / sumQtyShort;
    const lots = lotsFromSize(lv.size, startLots);
    totalSize += lv.size;
    totalLots += lots;
    sumLotMid += lots * pLong * mid0;
  }

  const basketAvg = totalLots > 0 ? sumLotMid / totalLots : mid0;

  const buySlRatio = avgRatioLong * (1 - slAvgFactor);
  const spotLongPct = Math.max(0, (1 - buySlRatio) * 100);
  const sellSlRatio = avgRatioShort * (1 + slAvgFactor);
  const spotShortPct = Math.max(0, (sellSlRatio - 1) * 100);
  const roiDefensePct = (spotLongPct + spotShortPct) / 2;

  // 표 마진 손절금(레거시): Size/표레버 × SL_ROI% × 로트스케일
  const lotScale = startLots / DCA1000_REF_LOTS;
  const tableMarginSlAmount =
    (totalSize / Math.max(1, lev)) * (slRoi / 100) * lotScale;

  // 엔진과 동일: 전체 바스켓 증거금 × SL_ROI%
  const sym = spreadInfo.symbol;
  const basketMargin = mt5UsedMargin({
    symbol: sym,
    lots: totalLots,
    avgPrice: basketAvg > 0 ? basketAvg : mid0,
    brokerLeverage: brokerLev,
  });
  const mt5CashSlAmount = roiPctToUsd(basketMargin, slRoi);

  return {
    stopLossRoiPct: slRoi,
    leverage: lev,
    levelCount: levels.length,
    totalSize: round2(totalSize),
    spotLongPct: round2(spotLongPct),
    spotShortPct: round2(spotShortPct),
    roiDefensePct: round2(roiDefensePct),
    estimatedSlAmount: round2(mt5CashSlAmount),
    tableMarginSlAmount: round2(tableMarginSlAmount),
    mt5CashSlAmount: round2(mt5CashSlAmount),
    avgEntryLong: round4(avgRatioLong),
    avgEntryShort: round4(avgRatioShort),
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
