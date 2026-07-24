import { prisma } from "./db";
import { fetchHistoryDeals, sumMt5TradePnl, type MetaDeal } from "./metaapi";
import { addSeoulDays, dayKeySeoul, seoulDayStartUtc } from "./day-key";

/** 계정당 history-deals 스로틀 (기본 90초) — 매틱 호출 비용 차단 */
const PNL_SYNC_THROTTLE_MS = Math.max(
  15_000,
  Number(process.env.PNL_SYNC_THROTTLE_MS || 90_000),
);
const lastPnlSyncAt = new Map<string, number>();

function groupDealsBySeoulDay(deals: MetaDeal[]) {
  const byDay = new Map<string, { pnl: number; trades: number }>();
  for (const d of deals) {
    if (!d.time) continue;
    const t = new Date(d.time);
    if (Number.isNaN(t.getTime())) continue;
    const typeOk = d.type === "DEAL_TYPE_BUY" || d.type === "DEAL_TYPE_SELL";
    if (!typeOk) continue;
    const k = dayKeySeoul(t);
    const cur = byDay.get(k) || { pnl: 0, trades: 0 };
    cur.pnl += Number(d.profit || 0) + Number(d.swap || 0) + Number(d.commission || 0);
    if (String(d.entryType || "").includes("OUT")) cur.trades += 1;
    byDay.set(k, cur);
  }
  return byDay;
}

/** 오늘(서울) MT5 총손익 → DailyStat 반영 */
export async function syncTodayPnlFromMt5Deals(opts: {
  accountId: string;
  metaApiAccountId: string;
  equity?: number;
  startingBalance?: number;
  /** true면 스로틀 무시 (청산 직후 등) */
  force?: boolean;
}) {
  const now = Date.now();
  const prev = lastPnlSyncAt.get(opts.accountId) ?? 0;
  if (!opts.force && now - prev < PNL_SYNC_THROTTLE_MS) {
    return { ok: true as const, skipped: true as const, dayPnl: null as number | null };
  }
  lastPnlSyncAt.set(opts.accountId, now);

  const day = dayKeySeoul();
  const start = seoulDayStartUtc(day);
  const end = new Date();
  const hist = await fetchHistoryDeals(opts.metaApiAccountId, start, end);
  if (!hist.ok) return { ok: false as const, message: hist.message };

  const dayPnl = Math.round(sumMt5TradePnl(hist.deals) * 100) / 100;
  const startEq = opts.startingBalance || opts.equity || 0;
  await prisma.dailyStat.upsert({
    where: { accountId_date: { accountId: opts.accountId, date: day } },
    create: {
      accountId: opts.accountId,
      date: day,
      startEquity: startEq,
      endEquity: opts.equity ?? startEq,
      pnl: dayPnl,
      returnPct: startEq > 0 ? (dayPnl / startEq) * 100 : 0,
      tpCount: 0,
      slCount: 0,
    },
    update: {
      endEquity: opts.equity ?? undefined,
      pnl: dayPnl,
      returnPct: startEq > 0 ? (dayPnl / startEq) * 100 : 0,
    },
  });
  return { ok: true as const, skipped: false as const, dayPnl, deals: hist.deals.length };
}

/** 최근 N일 MT5 딜 → 일자별 손익 (차트용) */
export async function mt5DailyPnlFromDeals(opts: {
  metaApiAccountId: string;
  daysBack?: number;
}) {
  const today = dayKeySeoul();
  const daysBack = opts.daysBack ?? 14;
  const start = seoulDayStartUtc(addSeoulDays(today, -daysBack));
  const end = new Date(Date.now() + 60_000);
  const hist = await fetchHistoryDeals(opts.metaApiAccountId, start, end);
  if (!hist.ok) return { ok: false as const, message: hist.message };

  const byDay = groupDealsBySeoulDay(hist.deals);
  const days = [...byDay.entries()]
    .map(([date, v]) => ({
      date,
      pnl: Math.round(v.pnl * 100) / 100,
      trades: v.trades,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const periodPnl = Math.round(sumMt5TradePnl(hist.deals) * 100) / 100;
  return { ok: true as const, days, totalPnl: periodPnl, dealCount: hist.deals.length };
}

/**
 * 제로마켓/MT5 「순손익」과 동일 소스:
 * 전 기간 BUY/SELL 딜 profit + swap + commission 합.
 */
export async function mt5LifetimeClosedPnl(opts: {
  metaApiAccountId: string;
  daysBack?: number;
}) {
  const daysBack = opts.daysBack ?? 400;
  const end = new Date(Date.now() + 60_000);
  const start = new Date(end.getTime() - daysBack * 86_400_000);
  const hist = await fetchHistoryDeals(opts.metaApiAccountId, start, end);
  if (!hist.ok) return { ok: false as const, message: hist.message };

  const totalPnl = Math.round(sumMt5TradePnl(hist.deals) * 100) / 100;
  const outTrades = hist.deals.filter(
    (d) =>
      (d.type === "DEAL_TYPE_BUY" || d.type === "DEAL_TYPE_SELL") &&
      String(d.entryType || "").includes("OUT"),
  ).length;

  return {
    ok: true as const,
    totalPnl,
    dealCount: hist.deals.length,
    outTrades,
    from: start.toISOString(),
    to: end.toISOString(),
  };
}
