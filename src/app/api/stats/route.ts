import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth";
import { runEngineTick } from "@/lib/engine";
import { prisma } from "@/lib/db";

export async function POST() {
  // Public tick endpoint for demo cron / client poll
  await runEngineTick();
  return NextResponse.json({ ok: true, at: new Date().toISOString() });
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const account = await prisma.brokerAccount.findFirst({
    where: { userId },
    include: {
      config: true,
      baskets: { where: { status: "open" }, include: { legs: true } },
      fills: { orderBy: { createdAt: "desc" }, take: 20 },
      snapshots: { orderBy: { createdAt: "desc" }, take: 48 },
      dailyStats: { orderBy: { date: "desc" }, take: 14 },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!account) return NextResponse.json({ account: null });

  const totalReturnPct =
    account.startingBalance > 0
      ? ((account.equity - account.startingBalance) / account.startingBalance) * 100
      : 0;
  const today = account.dailyStats[0] ?? null;

  return NextResponse.json({
    account: {
      id: account.id,
      login: account.login,
      server: account.server,
      mode: account.mode,
      status: account.status,
      botEnabled: account.botEnabled,
      balance: account.balance,
      equity: account.equity,
      startingBalance: account.startingBalance,
      tpCount: account.tpCount,
      slCount: account.slCount,
      cycleCount: account.cycleCount,
      totalReturnPct,
      dailyReturnPct: today?.returnPct ?? 0,
      dailyPnl: today?.pnl ?? 0,
      config: account.config,
      baskets: account.baskets,
      fills: account.fills,
      snapshots: account.snapshots.reverse(),
      dailyStats: account.dailyStats,
    },
  });
}
