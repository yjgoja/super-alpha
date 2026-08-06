/**
 * Cross-process trading guards (idempotency + shared soft-close / trade-credit backoff).
 * Fail-closed helpers for multi-instance engine (Render + GHA + UI).
 */
import { prisma } from "./db";

const GUARD_LOOKBACK_MS = 45 * 60_000;

export async function assertLevelNotAlreadyOpen(opts: {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  level: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const open = await prisma.basket.findFirst({
    where: {
      accountId: opts.accountId,
      symbol: opts.symbol,
      direction: opts.direction,
      status: "open",
    },
    include: { legs: { select: { level: true } } },
  });

  if (opts.level === 0 && open) {
    return { ok: false, reason: "basket_already_open" };
  }
  if (open?.legs.some((l) => l.level === opts.level)) {
    return { ok: false, reason: `leg_L${opts.level}_exists` };
  }

  const recent = await prisma.fill.findFirst({
    where: {
      accountId: opts.accountId,
      symbol: opts.symbol,
      side: opts.direction,
      kind: opts.level === 0 ? "ENTRY" : "DCA",
      level: opts.level,
      createdAt: { gte: new Date(Date.now() - 90_000) },
    },
    select: { id: true, createdAt: true },
  });
  if (recent) {
    // L0: allow immediate reentry after TP/SL/SESSION closed that cycle (H8 in-bar).
    if (opts.level === 0) {
      const closedAfter = await prisma.fill.findFirst({
        where: {
          accountId: opts.accountId,
          symbol: opts.symbol,
          kind: { in: ["TP", "SL", "SESSION"] },
          createdAt: { gte: recent.createdAt },
        },
        select: { id: true },
      });
      if (closedAfter) return { ok: true };
    }
    return { ok: false, reason: "recent_fill_idempotent" };
  }
  return { ok: true };
}

export async function getSharedSoftCloseCooldown(opts: {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
}): Promise<{ until: number; reason: string } | null> {
  const row = await prisma.fill.findFirst({
    where: {
      accountId: opts.accountId,
      symbol: opts.symbol,
      kind: "GUARD",
      note: { startsWith: "soft_close_cd|" },
      createdAt: { gte: new Date(Date.now() - GUARD_LOOKBACK_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { note: true },
  });
  if (!row?.note) return null;
  const parts = row.note.split("|");
  const until = Number(parts[1] || 0);
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  return { until, reason: parts[2] || "shared_backoff" };
}

export async function persistSoftCloseCooldown(opts: {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  reason: string;
  untilMs: number;
}): Promise<void> {
  const until = Date.now() + Math.max(5_000, opts.untilMs);
  try {
    await prisma.fill.create({
      data: {
        accountId: opts.accountId,
        symbol: opts.symbol,
        side: opts.direction === "BUY" ? "SELL" : "BUY",
        lots: 0,
        price: 0,
        pnl: 0,
        kind: "GUARD",
        note: `soft_close_cd|${until}|${opts.reason}`,
      },
    });
  } catch (e) {
    console.warn(
      "[trade-guards] persist soft-close failed",
      e instanceof Error ? e.message : e,
    );
  }
}

export async function persistTradeCreditPause(opts: {
  accountId: string;
  untilMs: number;
  reason?: string;
}): Promise<void> {
  const until = Date.now() + Math.max(30_000, opts.untilMs);
  try {
    await prisma.fill.create({
      data: {
        accountId: opts.accountId,
        symbol: "METAAPI",
        side: "BUY",
        lots: 0,
        price: 0,
        pnl: 0,
        kind: "GUARD",
        note: `trade_credit_cd|${until}|${opts.reason || "6h"}`,
      },
    });
  } catch (e) {
    console.warn(
      "[trade-guards] persist trade-credit failed",
      e instanceof Error ? e.message : e,
    );
  }
}

/** Returns global trade-credit pause until (ms epoch) if any recent GUARD says so. */
export async function readSharedTradeCreditUntil(): Promise<number> {
  const row = await prisma.fill.findFirst({
    where: {
      kind: "GUARD",
      note: { startsWith: "trade_credit_cd|" },
      createdAt: { gte: new Date(Date.now() - GUARD_LOOKBACK_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { note: true },
  });
  if (!row?.note) return 0;
  const until = Number(row.note.split("|")[1] || 0);
  return Number.isFinite(until) && until > Date.now() ? until : 0;
}

export function positionsAreNaked(
  positions: Array<{ takeProfit?: number; stopLoss?: number }>,
): boolean {
  if (!positions.length) return false;
  return positions.some((p) => !(Number(p.takeProfit) > 0 && Number(p.stopLoss) > 0));
}
