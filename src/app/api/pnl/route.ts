import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/access";
import { addSeoulDays, dayKeySeoul, seoulDayStartUtc } from "@/lib/day-key";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { ensureCloudLive, fetchSnapshot } from "@/lib/metaapi";
import { mt5DailyPnlFromDeals, mt5LifetimeClosedPnl } from "@/lib/mt5-pnl-sync";
import { padDailyPnl, withCumulative } from "@/lib/pnl-period";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type PnlJson = {
  days: ReturnType<typeof padDailyPnl>;
  cumulative: ReturnType<typeof withCumulative>;
  totalPnl: number;
  totalTrades: number;
  source: string;
  account?: {
    login: string;
    equity: number;
    balance: number;
    startingBalance: number;
  };
};

function emptyPnl(): PnlJson {
  return {
    days: [],
    cumulative: [],
    totalPnl: 0,
    totalTrades: 0,
    source: "none",
  };
}

/** DB-only — home first paint (no MetaAPI) */
async function pnlFromDb(account: {
  id: string;
  login: string;
  balance: number;
  equity: number;
  startingBalance: number;
  tpCount: number;
  slCount: number;
}): Promise<PnlJson> {
  const today = dayKeySeoul();
  const sinceKey = addSeoulDays(today, -14);
  const stats = await prisma.dailyStat.findMany({
    where: { accountId: account.id, date: { gte: sinceKey } },
    orderBy: { date: "asc" },
    select: { date: true, pnl: true, tpCount: true, slCount: true },
  });

  const rawDays = stats.map((s) => ({
    date: s.date,
    pnl: s.pnl,
    trades: (s.tpCount || 0) + (s.slCount || 0),
  }));
  const days =
    rawDays.length === 0 && account.equity === 0 && account.balance === 0
      ? []
      : padDailyPnl(rawDays, today);
  const cumulative = withCumulative(days);

  let totalPnl = 0;
  let source = "db";
  if (account.startingBalance > 0) {
    totalPnl = Math.round((account.balance - account.startingBalance) * 100) / 100;
    source = "balance_delta";
  } else if (stats.length) {
    totalPnl = Math.round(stats.reduce((a, s) => a + s.pnl, 0) * 100) / 100;
    source = "daily_stats_sum";
  }

  const totalTrades =
    account.tpCount + account.slCount ||
    rawDays.reduce((a, d) => a + d.trades, 0);

  return {
    days,
    cumulative,
    totalPnl,
    totalTrades,
    source,
    account: {
      login: account.login,
      equity: account.equity,
      balance: account.balance,
      startingBalance: account.startingBalance,
    },
  };
}

/** MetaAPI deals sync — slower; call with ?refresh=1 */
async function pnlFromMetaApi(account: {
  id: string;
  login: string;
  balance: number;
  equity: number;
  startingBalance: number;
  metaApiAccountId: string | null;
  tpCount: number;
  slCount: number;
}): Promise<PnlJson> {
  let balance = account.balance;
  let equity = account.equity;
  let startingBalance = account.startingBalance;

  if (account.metaApiAccountId) {
    const metaId = String(account.metaApiAccountId);
    let snap = await fetchSnapshot(metaId);
    if (!snap.ok) {
      const live = await ensureCloudLive(metaId, 20_000);
      if (live.ok && live.snap) snap = live.snap;
      else snap = await fetchSnapshot(metaId);
    }
    if (snap.ok) {
      balance = snap.balance;
      equity = snap.equity;
    }
  }

  const today = dayKeySeoul();
  let totalPnl = 0;
  let totalTrades = 0;
  let source = "none";
  let days = padDailyPnl([], today);
  let cumulative = withCumulative(days);

  if (account.metaApiAccountId) {
    // Parallel: lifetime + 14d daily (was sequential before)
    const [life, daily] = await Promise.all([
      mt5LifetimeClosedPnl({
        metaApiAccountId: account.metaApiAccountId,
        daysBack: 400,
      }),
      mt5DailyPnlFromDeals({
        metaApiAccountId: account.metaApiAccountId,
        daysBack: 14,
      }),
    ]);

    if (life.ok) {
      totalPnl = life.totalPnl;
      totalTrades = life.outTrades;
      source = "mt5_deals_lifetime";

      const calibrated = Math.round((balance - totalPnl) * 100) / 100;
      if (calibrated > 0 && Math.abs(calibrated - startingBalance) > 0.05) {
        startingBalance = calibrated;
        await prisma.brokerAccount.update({
          where: { id: account.id },
          data: {
            balance,
            equity,
            startingBalance: calibrated,
            lastSyncAt: new Date(),
          },
        });
      } else {
        await prisma.brokerAccount.update({
          where: { id: account.id },
          data: { balance, equity, lastSyncAt: new Date() },
        });
      }
    }

    if (daily.ok) {
      days = padDailyPnl(daily.days, today);
      cumulative = withCumulative(days);
      // Persist today's row so next fast load is accurate
      const todayRow = daily.days.find((d) => d.date === today);
      if (todayRow) {
        const startEq = startingBalance || equity || 0;
        await prisma.dailyStat.upsert({
          where: { accountId_date: { accountId: account.id, date: today } },
          create: {
            accountId: account.id,
            date: today,
            startEquity: startEq,
            endEquity: equity,
            pnl: todayRow.pnl,
            returnPct: startEq > 0 ? (todayRow.pnl / startEq) * 100 : 0,
            tpCount: 0,
            slCount: 0,
          },
          update: {
            endEquity: equity,
            pnl: todayRow.pnl,
            returnPct: startEq > 0 ? (todayRow.pnl / startEq) * 100 : 0,
          },
        });
      }
    }

    if (life.ok) {
      return {
        days,
        cumulative,
        totalPnl,
        totalTrades,
        source,
        account: {
          login: account.login,
          equity,
          balance,
          startingBalance,
        },
      };
    }
  }

  if (startingBalance > 0) {
    totalPnl = Math.round((balance - startingBalance) * 100) / 100;
    source = "balance_delta";
  }

  const since = seoulDayStartUtc(addSeoulDays(today, -14));
  const fills = await prisma.fill.findMany({
    where: {
      accountId: account.id,
      createdAt: { gte: since },
      kind: { in: ["TP", "SL"] },
    },
    select: { pnl: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const byDay = new Map<string, { pnl: number; trades: number }>();
  for (const f of fills) {
    const k = dayKeySeoul(f.createdAt);
    const cur = byDay.get(k) || { pnl: 0, trades: 0 };
    cur.pnl += f.pnl || 0;
    cur.trades += 1;
    byDay.set(k, cur);
  }

  days = padDailyPnl(
    [...byDay.entries()].map(([date, v]) => ({
      date,
      pnl: v.pnl,
      trades: v.trades,
    })),
    today,
  );
  cumulative = withCumulative(days);
  if (!totalTrades) totalTrades = fills.length;

  return {
    days,
    cumulative,
    totalPnl,
    totalTrades,
    source,
    account: {
      login: account.login,
      equity,
      balance,
      startingBalance,
    },
  };
}

/**
 * GET /api/pnl — fast DB by default.
 * Pass ?refresh=1 to sync from MetaAPI (slower).
 */
export async function GET(req: NextRequest) {
  const gate = await requireUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const wantRefresh = req.nextUrl.searchParams.get("refresh") === "1";

  const account = await prisma.brokerAccount.findFirst({
    where: { userId: gate.user.id },
    orderBy: { createdAt: "desc" },
  });
  if (!account) {
    return NextResponse.json(emptyPnl(), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const body = wantRefresh
    ? await pnlFromMetaApi(account)
    : await pnlFromDb(account);

  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
