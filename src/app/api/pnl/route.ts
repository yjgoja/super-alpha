import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/lib/access";
import { addSeoulDays, dayKeySeoul, seoulDayStartUtc } from "@/lib/day-key";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { padDailyPnl, withCumulative } from "@/lib/pnl-period";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const account = await prisma.brokerAccount.findFirst({
    where: { userId: gate.user.id },
    orderBy: { createdAt: "desc" },
  });
  if (!account) {
    return NextResponse.json(
      {
        days: [],
        cumulative: [],
        totalPnl: 0,
        totalTrades: 0,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const today = dayKeySeoul();
  const since = seoulDayStartUtc(addSeoulDays(today, -14));

  const fills = await prisma.fill.findMany({
    where: { accountId: account.id, createdAt: { gte: since } },
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

  // Always exactly the last 5 Seoul calendar days (zeros when no fills)
  const days = padDailyPnl(
    [...byDay.entries()].map(([date, v]) => ({
      date,
      pnl: v.pnl,
      trades: v.trades,
    })),
    today,
  );
  const cumulative = withCumulative(days);

  const allPnl = fills.reduce((s, f) => s + (f.pnl || 0), 0);
  const totalTrades = fills.length;

  return NextResponse.json(
    {
      days,
      cumulative,
      totalPnl: Math.round(allPnl * 100) / 100,
      totalTrades,
      account: {
        login: account.login,
        equity: account.equity,
        balance: account.balance,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
