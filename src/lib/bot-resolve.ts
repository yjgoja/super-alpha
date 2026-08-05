/**
 * SymbolBot row binding for the live engine.
 *
 * Fail-closed rules (godcjfl 2026-08 regression):
 * - New risk (manageOnly=false) MUST bind an enabled row whose logic owns that side.
 * - H8 time logics ignore DB direction; they claim a session side via ownerLogic.
 * - Never open new risk under a disabled / wrong-logic row that happens to share symbol|side.
 */
import { symbolsMatch } from "./metaapi";
import { normalizeLogicId } from "./strategies";
import { isMartin9TimeLogic } from "./table-logics";

export type BotRowLite = {
  symbol: string;
  direction: string;
  dualDirection?: boolean | null;
  enabled: boolean;
  logic: string;
};

export type NeededSide = {
  manageOnly: boolean;
  /** Logic that claimed this side for trading; time wins on conflict. */
  ownerLogic?: string;
};

export function botSide(direction: string): "BUY" | "SELL" {
  return direction === "SELL" ? "SELL" : "BUY";
}

export function pickOwnerLogic(
  a?: string | null,
  b?: string | null,
): string | undefined {
  const na = a ? normalizeLogicId(a) : undefined;
  const nb = b ? normalizeLogicId(b) : undefined;
  if (na && isMartin9TimeLogic(na)) return na;
  if (nb && isMartin9TimeLogic(nb)) return nb;
  return na || nb;
}

export function mergeNeededSide(
  prev: NeededSide | undefined,
  next: NeededSide,
): NeededSide {
  if (!prev) return { ...next, ownerLogic: next.ownerLogic ? normalizeLogicId(next.ownerLogic) : undefined };
  return {
    manageOnly: prev.manageOnly || next.manageOnly,
    ownerLogic: pickOwnerLogic(prev.ownerLogic, next.ownerLogic),
  };
}

function onSymbol<T extends BotRowLite>(bots: T[], symbol: string): T[] {
  return bots.filter((b) => symbolsMatch(b.symbol, symbol));
}

function logicOf(b: BotRowLite) {
  return normalizeLogicId(b.logic);
}

/**
 * Resolve which SymbolBot row drives a symbol|side tick.
 * - With ownerLogic: that logic wins (enabled required unless manageOnly).
 * - New risk: never return a disabled row (null = skip entry).
 * - manageOnly: may fall back to disabled matching rows for TP/SL only.
 */
export function resolveSymbolBotForSide<T extends BotRowLite>(opts: {
  bots: T[];
  symbol: string;
  direction: "BUY" | "SELL";
  manageOnly: boolean;
  ownerLogic?: string;
}): T | null {
  const rows = onSymbol(opts.bots, opts.symbol);
  if (rows.length === 0) return null;

  const want = opts.ownerLogic ? normalizeLogicId(opts.ownerLogic) : undefined;
  if (want) {
    const enabled = rows.find((b) => b.enabled && logicOf(b) === want);
    if (enabled) return enabled;
    if (!opts.manageOnly) return null;
    const any = rows.find((b) => logicOf(b) === want);
    if (any) return any;
    // Owner claimed but row gone — do not bind a different logic for new risk.
    if (!opts.manageOnly) return null;
  }

  const enabledExact = rows.find(
    (b) =>
      b.enabled &&
      !isMartin9TimeLogic(b.logic) &&
      !b.dualDirection &&
      botSide(b.direction) === opts.direction,
  );
  if (enabledExact) return enabledExact;

  const enabledTime = rows.find((b) => b.enabled && isMartin9TimeLogic(b.logic));
  if (enabledTime) return enabledTime;

  const enabledDual = rows.find((b) => b.enabled && !!b.dualDirection);
  if (enabledDual) return enabledDual;

  if (!opts.manageOnly) return null;

  const disabledTime = rows.find((b) => isMartin9TimeLogic(b.logic));
  if (disabledTime) return disabledTime;

  const disabledExact = rows.find(
    (b) => !b.dualDirection && botSide(b.direction) === opts.direction,
  );
  if (disabledExact) return disabledExact;

  const disabledDual = rows.find((b) => !!b.dualDirection);
  return disabledDual ?? null;
}

/** True if an enabled bot may open/manage new risk on this side. */
export function hasEnabledTraderForSide(
  bots: BotRowLite[],
  symbol: string,
  direction: "BUY" | "SELL",
  ownerLogic?: string,
): boolean {
  return !!resolveSymbolBotForSide({
    bots,
    symbol,
    direction,
    manageOnly: false,
    ownerLogic,
  });
}

/**
 * Pick enabled non-time bot for TP reentry / fixed-side ops.
 * H8 time logics must not reenter via this path.
 */
export function resolveEnabledFixedBotForSide<T extends BotRowLite>(opts: {
  bots: T[];
  symbol: string;
  direction: "BUY" | "SELL";
}): T | null {
  const rows = onSymbol(opts.bots, opts.symbol).filter(
    (b) => b.enabled && !isMartin9TimeLogic(b.logic),
  );
  const exact = rows.find(
    (b) => !b.dualDirection && botSide(b.direction) === opts.direction,
  );
  if (exact) return exact;
  return rows.find((b) => !!b.dualDirection) ?? null;
}

/** stopOnSl / side-disable must not kill H8 time rows (they ignore DB direction). */
export function shouldDisableOnSideStop(bot: BotRowLite): boolean {
  return !isMartin9TimeLogic(bot.logic);
}
