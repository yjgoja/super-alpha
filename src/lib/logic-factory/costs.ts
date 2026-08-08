/**
 * 백테스트 거래비용 — 오너 실측값 (2026-08-09 확인).
 *
 * 그동안 백테스트는 합성 바에 박힌 스프레드(XAU 0.25 / GBP 0.00012 / EUR 0.0001)를
 * 그대로 썼는데, 실제 브로커 스프레드의 절반도 안 되는 값이라 결과가 낙관적으로
 * 나왔다. 리베이트는 아예 모델에 없었다.
 *
 *   FX  (EURUSD·GBPUSD·AUDUSD) : 1랏당 $25~28 스프레드
 *   XAU (XAUUSD)               : 1랏당 $38~40 스프레드
 *   공통                        : 1랏당 $20 리베이트
 *
 * 보수적으로 스프레드는 상단(28 / 40)을 쓴다. 백테스트가 실전보다 좋게 나오는
 * 것보다 나쁘게 나오는 편이 안전하다.
 */
import { contractSizeForSymbol } from "../dca1000";

/** 1랏당 스프레드 비용($). 상단값 — 낙관 편향 방지. */
export const SPREAD_USD_PER_LOT_FX = Number(process.env.FACTORY_SPREAD_FX_USD || 28);
export const SPREAD_USD_PER_LOT_XAU = Number(process.env.FACTORY_SPREAD_XAU_USD || 40);
/** 1랏당 리베이트($). 종목 공통. */
export const REBATE_USD_PER_LOT = Number(process.env.FACTORY_REBATE_USD || 20);

function isGold(symbol: string) {
  const s = (symbol || "").toUpperCase();
  return s.startsWith("XAU") || s === "GOLD";
}

/** 1랏당 스프레드 비용($) */
export function spreadUsdPerLot(symbol: string): number {
  return isGold(symbol) ? SPREAD_USD_PER_LOT_XAU : SPREAD_USD_PER_LOT_FX;
}

/**
 * 1랏당 비용($)을 가격 단위 스프레드로 환산한다.
 *   FX  : $28 / 100,000 = 0.00028 (2.8 pip)
 *   XAU : $40 / 100     = 0.40
 */
export function spreadInPrice(symbol: string): number {
  const cs = contractSizeForSymbol(symbol);
  return cs > 0 ? spreadUsdPerLot(symbol) / cs : 0;
}

/** 체결 로트 합계에 대한 리베이트($) */
export function rebateUsd(totalLots: number): number {
  return Math.max(0, totalLots) * REBATE_USD_PER_LOT;
}

/** 참고용 — 스프레드에서 리베이트를 뺀 1랏당 순비용($) */
export function netCostUsdPerLot(symbol: string): number {
  return spreadUsdPerLot(symbol) - REBATE_USD_PER_LOT;
}
