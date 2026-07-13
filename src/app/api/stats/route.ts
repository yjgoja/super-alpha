import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { syncMt5Account } from "@/lib/metaapi";

export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const account = await prisma.brokerAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  if (!account?.metaApiAccountId) {
    return NextResponse.json({
      ok: false,
      error: "MetaAPI에 연결된 실계좌가 없습니다.",
    });
  }

  const snap = await syncMt5Account(account.metaApiAccountId);
  if (!snap.ok) {
    return NextResponse.json({ ok: false, error: snap.message }, { status: 400 });
  }

  await prisma.brokerAccount.update({
    where: { id: account.id },
    data: {
      balance: snap.balance,
      equity: snap.equity,
      lastSyncAt: new Date(),
      mode: "live",
      status: "connected",
    },
  });

  await prisma.basketLeg.deleteMany({
    where: { basket: { accountId: account.id, status: "open" } },
  });
  await prisma.basket.deleteMany({
    where: { accountId: account.id, status: "open" },
  });

  const bySymbol = new Map<string, typeof snap.positions>();
  for (const p of snap.positions) {
    const list = bySymbol.get(p.symbol) ?? [];
    list.push(p);
    bySymbol.set(p.symbol, list);
  }
  for (const [symbol, legs] of bySymbol) {
    const first = legs[0];
    const unrealized = legs.reduce((s, l) => s + l.profit, 0);
    await prisma.basket.create({
      data: {
        accountId: account.id,
        symbol,
        direction: first.direction,
        filledLevel: Math.max(0, legs.length - 1),
        firstEntryPrice: first.price,
        status: "open",
        unrealizedPnl: unrealized,
        legs: {
          create: legs.map((l, idx) => ({
            level: idx,
            lots: l.lots,
            price: l.price,
          })),
        },
      },
    });
  }

  await prisma.equitySnapshot.create({
    data: {
      accountId: account.id,
      equity: snap.equity,
      balance: snap.balance,
    },
  });

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
      metaApiAccountId: account.metaApiAccountId,
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
