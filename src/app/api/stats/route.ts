import { NextRequest, NextResponse } from "next/server";
import { requireApprovedUser } from "@/lib/access";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { fetchSnapshot, syncMt5Account } from "@/lib/metaapi";
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

/**
 * Fast path: DB only. Pass ?live=1 for MetaAPI snapshot (positions + equity).
 * Bot OFF여도 연결된 계좌의 열린 포지션을 표시한다.
 */
export async function GET(req: NextRequest) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const wantLive = req.nextUrl.searchParams.get("live") === "1";

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

  type LivePos = Extract<Awaited<ReturnType<typeof fetchSnapshot>>, { ok: true }>["positions"];
  let livePositions: LivePos = [];
  let syncError: string | null = null;

  if (wantLive) {
    if (!account.metaApiAccountId) {
      syncError = "MetaAPI에 연결된 실계좌가 없습니다.";
    } else {
      const snap = await fetchSnapshot(String(account.metaApiAccountId));
      if (snap.ok) {
        await prisma.brokerAccount.update({
          where: { id: account.id },
          data: {
            balance: snap.balance,
            equity: snap.equity,
            lastSyncAt: new Date(),
            statusMessage: account.botEnabled
              ? "클라우드 연결 · 봇 실행 중"
              : "클라우드 연결 · 포지션 동기화",
          },
        });
        account.balance = snap.balance;
        account.equity = snap.equity;
        account.lastSyncAt = new Date();
        livePositions = snap.positions;
      } else {
        syncError = snap.message;
      }
    }
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
      livePositions: wantLive ? livePositions : undefined,
      syncError: wantLive ? syncError : undefined,
    },
  });
}
