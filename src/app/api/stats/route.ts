import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/lib/access";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { syncMt5Account } from "@/lib/metaapi";
import { runDcaTick } from "@/lib/meta-engine";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Soft equity sync only — never rebuild baskets (that desynced filledLevel vs engine).
 * When bot is ON, also run one user-scoped DCA tick (supplement to GHA / local engine).
 */
export async function POST() {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const account = await prisma.brokerAccount.findFirst({
    where: { userId: gate.user.id },
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
      status: account.botEnabled ? "connected" : account.status,
    },
  });

  let tick: unknown = null;
  if (account.botEnabled && account.status !== "failed") {
    try {
      tick = await runDcaTick(account.id);
    } catch (e) {
      tick = { ok: false, error: e instanceof Error ? e.message : "tick error" };
    }
  }

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    tick,
  });
}

export async function GET() {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const account = await prisma.brokerAccount.findFirst({
    where: { userId: gate.user.id },
    include: {
      config: true,
      baskets: { where: { status: "open" }, include: { legs: true } },
      fills: { orderBy: { createdAt: "desc" }, take: 20 },
      snapshots: { orderBy: { createdAt: "desc" }, take: 48 },
      dailyStats: { orderBy: { date: "desc" }, take: 14 },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!account) {
    return NextResponse.json({
      role: gate.user.role,
      account: null,
    });
  }

  const start =
    account.startingBalance > 0 ? account.startingBalance : account.balance || 1;
  const totalReturnPct = ((account.equity - start) / start) * 100;
  const today = account.dailyStats[0] ?? null;
  const syncAgeSec = account.lastSyncAt
    ? Math.max(0, Math.floor((Date.now() - account.lastSyncAt.getTime()) / 1000))
    : null;

  return NextResponse.json({
    role: gate.user.role,
    account: {
      id: account.id,
      login: account.login,
      server: account.server,
      mode: account.mode,
      status: account.status,
      statusMessage: account.statusMessage,
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
