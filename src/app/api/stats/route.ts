import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth";
import { runEngineTick } from "@/lib/engine";
import { prisma } from "@/lib/db";

export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) {
    // allow anonymous demo tick only for accounts still in demo mode
    await runEngineTick();
    return NextResponse.json({ ok: true, at: new Date().toISOString() });
  }

  const account = await prisma.brokerAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  // Live accounts are driven by MT5 EA sync — do not run paper engine
  if (account?.mode === "live") {
    return NextResponse.json({
      ok: true,
      skipped: "live",
      lastSyncAt: account.lastSyncAt,
      at: new Date().toISOString(),
    });
  }

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

  const start =
    account.startingBalance > 0 ? account.startingBalance : account.balance || 1;
  const totalReturnPct = ((account.equity - start) / start) * 100;
  const today = account.dailyStats[0] ?? null;
  const syncAgeSec = account.lastSyncAt
    ? Math.max(0, Math.floor((Date.now() - account.lastSyncAt.getTime()) / 1000))
    : null;

  return NextResponse.json({
    account: {
      id: account.id,
      login: account.login,
      server: account.server,
      mode: account.mode,
      status: account.status,
      syncToken: account.syncToken,
      lastSyncAt: account.lastSyncAt,
      syncAgeSec,
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
